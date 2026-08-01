import type { ServiceConfig } from "./config.js";
import { CommerceDomainError, type PointBalance } from "./domain.js";
import type { AppleTransactionVerifier } from "./apple.js";
import type {
  AccountIdentity,
  PostgresCommerceRepository,
} from "./postgres.js";

export type CommerceRepositoryPort = Pick<PostgresCommerceRepository,
  | "startAnonymousSession"
  | "recoverAnonymousSession"
  | "authenticateSession"
  | "getBalance"
  | "authorizeRun"
  | "completeRun"
  | "creditApplePurchase"
  | "applyAppleRevocation"
  | "rotateRecoveryToken"
>;

export class HostedAiCommerceService {
  constructor(
    private readonly config: ServiceConfig,
    private readonly repository: CommerceRepositoryPort,
    private readonly appleVerifier: AppleTransactionVerifier,
  ) {}

  async startAnonymousSession(input: unknown) {
    const body = object(input);
    const installationId = uuid(body.installationId, "installationId");
    const platform = platformValue(body.platform);
    const appVersion = shortText(body.appVersion, "appVersion", 40);
    const session = await this.repository.startAnonymousSession({ installationId, platform, appVersion });
    return {
      ...this.accountPayload(session, session.balance),
      sessionToken: session.sessionToken,
      sessionExpiresAt: session.sessionExpiresAt,
      ...(session.recoveryToken ? { recoveryToken: session.recoveryToken } : {}),
    };
  }

  async recoverAnonymousSession(input: unknown) {
    const body = object(input);
    const session = await this.repository.recoverAnonymousSession({
      recoveryToken: recoveryToken(body.recoveryToken),
      installationId: uuid(body.installationId, "installationId"),
      platform: platformValue(body.platform),
      appVersion: shortText(body.appVersion, "appVersion", 40),
    });
    return {
      ...this.accountPayload(session, session.balance),
      sessionToken: session.sessionToken,
      sessionExpiresAt: session.sessionExpiresAt,
    };
  }

  async rotateRecoveryToken(sessionToken: string): Promise<{ recoveryToken: string }> {
    const account = await this.repository.authenticateSession(sessionToken);
    return { recoveryToken: await this.repository.rotateRecoveryToken(account.accountId) };
  }

  async getAccount(sessionToken: string) {
    const account = await this.repository.authenticateSession(sessionToken);
    return this.accountPayload(account, await this.repository.getBalance(account.accountId));
  }

  async authorizeRun(sessionToken: string, input: unknown, idempotencyKey?: string) {
    const account = await this.repository.authenticateSession(sessionToken);
    const body = object(input);
    const requestId = uuid(body.requestId, "requestId");
    if (idempotencyKey !== requestId) {
      throw new CommerceDomainError("invalid_idempotency_key", "Idempotency-Key 必须与 requestId 一致", 400);
    }
    const flowId = shortText(body.flowId, "flowId", 160);
    const modelId = shortText(body.modelId, "modelId", 160);
    const model = this.config.models.find((candidate) => candidate.id === modelId);
    if (!model) throw new CommerceDomainError("model_unavailable", "当前模型不可用", 403);
    const authorization = await this.repository.authorizeRun({
      accountId: account.accountId,
      requestId,
      flowId,
      model,
      ttlSeconds: this.config.runTtlSeconds,
    });
    return {
      authorizationId: authorization.run.id,
      apiBaseUrl: `${this.config.publicBaseUrl}/api/app/v1/gateway/v1`,
      apiKey: authorization.apiKey,
      expiresAt: authorization.run.expiresAt,
      balance: publicBalance(authorization.balance),
    };
  }

  async completeRun(sessionToken: string, input: unknown) {
    const account = await this.repository.authenticateSession(sessionToken);
    const body = object(input);
    const authorizationId = uuid(body.authorizationId, "authorizationId");
    return { balance: publicBalance(await this.repository.completeRun(account.accountId, authorizationId)) };
  }

  async redeemApplePurchase(sessionToken: string, input: unknown) {
    const account = await this.repository.authenticateSession(sessionToken);
    const body = object(input);
    const appAccountToken = uuid(body.appAccountToken, "appAccountToken").toLowerCase();
    if (account.appAccountToken.toLowerCase() !== appAccountToken) {
      throw new CommerceDomainError("account_token_mismatch", "App Store 账户标识不匹配", 403);
    }
    const signedTransactionInfo = longText(body.signedTransactionInfo, "signedTransactionInfo", 64_000);
    const transaction = await this.appleVerifier.verifyTransaction(signedTransactionInfo);
    const pointPack = this.config.pointPacks.find(
      (candidate) => candidate.appleProductId === transaction.productId,
    );
    if (!pointPack) throw new CommerceDomainError("unknown_product", "App Store 商品不属于当前点数目录", 400);
    const result = await this.repository.creditApplePurchase({
      account,
      transaction,
      pointPack,
      signedTransactionInfo,
    });
    return {
      transactionId: result.transactionId,
      creditedPoints: result.creditedPoints,
      balance: publicBalance(result.balance),
    };
  }

  async handleAppleNotification(input: unknown): Promise<{ accepted: true }> {
    const body = object(input);
    const signedPayload = longText(body.signedPayload, "signedPayload", 128_000);
    const notification = await this.appleVerifier.verifyNotification(signedPayload);
    const revocationTypes = new Set(["REFUND", "REVOKE"]);
    if (notification.transaction
      && (notification.transaction.revokedAt || revocationTypes.has(notification.notificationType))) {
      const pointPack = this.config.pointPacks.find(
        (candidate) => candidate.appleProductId === notification.transaction!.productId,
      );
      if (pointPack) {
        await this.repository.applyAppleRevocation({
          transaction: notification.transaction,
          pointPack,
          signedPayload,
        });
      }
    }
    return { accepted: true };
  }

  private accountPayload(account: AccountIdentity, balance: PointBalance) {
    return {
      accountId: account.accountId,
      appAccountToken: account.appAccountToken,
      balance: publicBalance(balance),
      models: this.config.models.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        inputPointsPerMillionTokens: model.inputPointsPerMillionTokens,
        outputPointsPerMillionTokens: model.outputPointsPerMillionTokens,
        capabilities: model.capabilities,
      })),
      pointPacks: this.config.pointPacks.map((pack) => ({ ...pack })),
    };
  }
}

function publicBalance(balance: PointBalance) {
  return {
    availablePoints: balance.availablePoints,
    purchasedPoints: balance.purchasedPoints,
    grantedPoints: balance.grantedPoints,
    updatedAt: balance.updatedAt,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CommerceDomainError("invalid_request", "请求体必须是 JSON 对象", 400);
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
  const text = shortText(value, label, 36).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) {
    throw new CommerceDomainError("invalid_request", `${label} 必须是 UUID`, 400);
  }
  return text;
}

function platformValue(value: unknown): "windows" | "macos" | "linux" | "android" | "ios" {
  if (value === "windows" || value === "macos" || value === "linux" || value === "android" || value === "ios") return value;
  throw new CommerceDomainError("invalid_request", "platform 无效", 400);
}

function shortText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new CommerceDomainError("invalid_request", `${label} 无效`, 400);
  }
  return value.trim();
}

function longText(value: unknown, label: string, maximum: number): string {
  const text = shortText(value, label, maximum);
  if (text.length < 64) throw new CommerceDomainError("invalid_request", `${label} 无效`, 400);
  return text;
}

function recoveryToken(value: unknown): string {
  const text = shortText(value, "recoveryToken", 80);
  if (!/^nkg_recover_[A-Za-z0-9_-]{43}$/.test(text)) {
    throw new CommerceDomainError("invalid_request", "账户恢复码格式无效", 400);
  }
  return text;
}
