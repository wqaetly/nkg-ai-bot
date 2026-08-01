import type { FlowInvokeOptions } from "@nkg-ai-bot/runtime-router";
import {
  HOSTED_AI_RECOVERY_TOKEN_REF,
  HOSTED_AI_SESSION_TOKEN_REF,
  HostedAiApiError,
  type AuthorizeHostedAiRunInput,
  type HostedAiAccount,
  type HostedAiClient,
  type HostedAiPlatform,
  type HostedAiPurchaseResult,
  type HostedAiRunAuthorization,
  type RedeemApplePurchaseInput,
  type RecoverHostedAiSessionInput,
  type StartHostedAiSessionInput,
} from "./hostedAi";
import {
  getHostedAiInstallationId,
  setHostedAiInstallationId,
} from "./storage/database";
import type { ApiKeyVault } from "./storage/secretVault";

export type HostedAiSessionState = "idle" | "connecting" | "ready" | "unavailable";

export interface HostedAiSessionSnapshot {
  state: HostedAiSessionState;
  account?: HostedAiAccount;
  error?: string;
}

export interface HostedAiInstallationStore {
  getInstallationId(): Promise<string | undefined>;
  setInstallationId(installationId: string): Promise<void>;
}

export interface HostedAiClientPort {
  startAnonymousSession(
    input: StartHostedAiSessionInput,
    signal?: AbortSignal,
  ): ReturnType<HostedAiClient["startAnonymousSession"]>;
  getAccount(
    sessionToken: string,
    signal?: AbortSignal,
  ): ReturnType<HostedAiClient["getAccount"]>;
  recoverAnonymousSession(
    input: RecoverHostedAiSessionInput,
    signal?: AbortSignal,
  ): ReturnType<HostedAiClient["recoverAnonymousSession"]>;
  rotateRecoveryToken(
    sessionToken: string,
    signal?: AbortSignal,
  ): ReturnType<HostedAiClient["rotateRecoveryToken"]>;
  createRunOptions(
    sessionToken: string,
    input: AuthorizeHostedAiRunInput,
    options?: FlowInvokeOptions,
    signal?: AbortSignal,
  ): ReturnType<HostedAiClient["createRunOptions"]>;
  completeRun(
    sessionToken: string,
    authorizationId: string,
    signal?: AbortSignal,
  ): ReturnType<HostedAiClient["completeRun"]>;
  redeemApplePurchase(
    sessionToken: string,
    input: RedeemApplePurchaseInput,
    signal?: AbortSignal,
  ): ReturnType<HostedAiClient["redeemApplePurchase"]>;
}

const sqliteInstallationStore: HostedAiInstallationStore = {
  getInstallationId: () => getHostedAiInstallationId(),
  setInstallationId: (installationId) => setHostedAiInstallationId(installationId),
};

/**
 * Owns the anonymous NKG account session while keeping the server authoritative
 * for balances. Only the session token is persisted in Stronghold; point totals
 * are deliberately not written to SQLite as spendable state.
 */
export class HostedAiSession {
  private snapshotValue: HostedAiSessionSnapshot = { state: "idle" };
  private sessionToken: string | undefined;
  private vault: ApiKeyVault | undefined;
  private connectionInput: { platform: HostedAiPlatform; appVersion: string } | undefined;
  private initialization: Promise<HostedAiSessionSnapshot> | undefined;
  private readonly subscribers = new Set<() => void>();

  constructor(
    private readonly client: HostedAiClientPort,
    private readonly installationStore: HostedAiInstallationStore = sqliteInstallationStore,
  ) {}

  get snapshot(): HostedAiSessionSnapshot {
    return cloneSnapshot(this.snapshotValue);
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  lock(): void {
    this.sessionToken = undefined;
    this.vault = undefined;
    this.connectionInput = undefined;
    this.setSnapshot({ state: "idle" });
  }

  initialize(
    vault: ApiKeyVault,
    input: { platform: HostedAiPlatform; appVersion: string },
    signal?: AbortSignal,
  ): Promise<HostedAiSessionSnapshot> {
    this.vault = vault;
    this.connectionInput = input;
    this.initialization ??= this.connect(vault, input, signal)
      .finally(() => { this.initialization = undefined; });
    return this.initialization;
  }

  async refresh(vault: ApiKeyVault, signal?: AbortSignal): Promise<HostedAiSessionSnapshot> {
    const token = this.sessionToken ?? await vault.getApiKey(HOSTED_AI_SESSION_TOKEN_REF);
    if (!token) throw new Error("NKG AI 尚未建立本机账户");
    this.setSnapshot({ state: "connecting", ...(this.snapshotValue.account
      ? { account: this.snapshotValue.account }
      : {}) });
    try {
      const account = await this.client.getAccount(token, signal);
      this.sessionToken = token;
      this.setSnapshot({ state: "ready", account });
      return this.snapshot;
    } catch (cause) {
      if (cause instanceof HostedAiApiError && cause.status === 401) {
        this.sessionToken = undefined;
        await vault.removeApiKey(HOSTED_AI_SESSION_TOKEN_REF);
      }
      this.setSnapshot({
        state: "unavailable",
        ...(this.snapshotValue.account ? { account: this.snapshotValue.account } : {}),
        error: publicError(cause),
      });
      throw cause;
    }
  }

  async createRunOptions(
    input: AuthorizeHostedAiRunInput,
    options: FlowInvokeOptions = {},
    signal?: AbortSignal,
  ): Promise<{ options: FlowInvokeOptions; authorization: HostedAiRunAuthorization }> {
    const token = this.requireReadyToken();
    const account = this.snapshotValue.account;
    if (!account?.models.some((model) => model.id === input.modelId)) {
      throw new Error(`NKG AI 模型“${input.modelId}”当前不可用`);
    }
    try {
      const result = await this.client.createRunOptions(token, input, options, signal);
      this.setSnapshot({
        state: "ready",
        account: { ...account, balance: result.authorization.balance },
      });
      return result;
    } catch (cause) {
      await this.invalidateExpiredSession(cause);
      throw cause;
    }
  }

  async redeemApplePurchase(
    input: RedeemApplePurchaseInput,
    signal?: AbortSignal,
  ): Promise<HostedAiPurchaseResult> {
    const token = this.requireReadyToken();
    try {
      const result = await this.client.redeemApplePurchase(token, input, signal);
      if (this.snapshotValue.account) {
        this.setSnapshot({
          state: "ready",
          account: { ...this.snapshotValue.account, balance: result.balance },
        });
      }
      return result;
    } catch (cause) {
      await this.invalidateExpiredSession(cause);
      throw cause;
    }
  }

  async completeRun(authorizationId: string, signal?: AbortSignal): Promise<void> {
    const token = this.requireReadyToken();
    try {
      const balance = await this.client.completeRun(token, authorizationId, signal);
      if (this.snapshotValue.account) {
        this.setSnapshot({
          state: "ready",
          account: { ...this.snapshotValue.account, balance },
        });
      }
    } catch (cause) {
      await this.invalidateExpiredSession(cause);
      throw cause;
    }
  }

  async getOrCreateRecoveryToken(signal?: AbortSignal): Promise<string> {
    const vault = this.requireVault();
    const stored = await vault.getApiKey(HOSTED_AI_RECOVERY_TOKEN_REF);
    if (stored) return stored;
    const token = this.requireReadyToken();
    const recoveryToken = await this.client.rotateRecoveryToken(token, signal);
    await vault.setApiKey(HOSTED_AI_RECOVERY_TOKEN_REF, recoveryToken);
    return recoveryToken;
  }

  async recoverAccount(recoveryToken: string, signal?: AbortSignal): Promise<HostedAiSessionSnapshot> {
    const vault = this.requireVault();
    const input = this.connectionInput;
    if (!input) throw new Error("NKG AI 尚未初始化");
    const previousAccount = this.snapshotValue.account;
    this.setSnapshot({ state: "connecting", ...(previousAccount ? { account: previousAccount } : {}) });
    try {
      const grant = await this.client.recoverAnonymousSession({
        ...input,
        installationId: await this.getOrCreateInstallationId(),
        recoveryToken,
      }, signal);
      await this.acceptSessionGrant(vault, grant, recoveryToken);
      return this.snapshot;
    } catch (cause) {
      this.setSnapshot({
        state: "unavailable",
        ...(previousAccount ? { account: previousAccount } : {}),
        error: publicError(cause),
      });
      throw cause;
    }
  }

  private async invalidateExpiredSession(cause: unknown): Promise<void> {
    if (!(cause instanceof HostedAiApiError) || cause.status !== 401) return;
    this.sessionToken = undefined;
    await this.vault?.removeApiKey(HOSTED_AI_SESSION_TOKEN_REF);
    this.setSnapshot({ state: "unavailable", error: publicError(cause) });
  }

  private async connect(
    vault: ApiKeyVault,
    input: { platform: HostedAiPlatform; appVersion: string },
    signal?: AbortSignal,
  ): Promise<HostedAiSessionSnapshot> {
    this.setSnapshot({ state: "connecting" });
    const storedToken = await vault.getApiKey(HOSTED_AI_SESSION_TOKEN_REF);
    if (storedToken) {
      try {
        const account = await this.client.getAccount(storedToken, signal);
        this.sessionToken = storedToken;
        this.setSnapshot({ state: "ready", account });
        return this.snapshot;
      } catch (cause) {
        if (!(cause instanceof HostedAiApiError) || cause.status !== 401) {
          this.setSnapshot({ state: "unavailable", error: publicError(cause) });
          return this.snapshot;
        }
        await vault.removeApiKey(HOSTED_AI_SESSION_TOKEN_REF);
      }
    }

    try {
      const installationId = await this.getOrCreateInstallationId();
      const grant = await this.client.startAnonymousSession({
        installationId,
        platform: input.platform,
        appVersion: input.appVersion,
      }, signal);
      await this.acceptSessionGrant(vault, grant, grant.recoveryToken);
      return this.snapshot;
    } catch (cause) {
      this.setSnapshot({ state: "unavailable", error: publicError(cause) });
      return this.snapshot;
    }
  }

  private async getOrCreateInstallationId(): Promise<string> {
    const stored = await this.installationStore.getInstallationId();
    if (stored) return stored;
    const installationId = crypto.randomUUID();
    await this.installationStore.setInstallationId(installationId);
    return installationId;
  }

  private requireReadyToken(): string {
    if (this.snapshotValue.state !== "ready" || !this.sessionToken) {
      throw new Error("NKG AI 服务尚未连接");
    }
    return this.sessionToken;
  }

  private requireVault(): ApiKeyVault {
    if (!this.vault) throw new Error("NKG AI 本地安全存储不可用");
    return this.vault;
  }

  private async acceptSessionGrant(
    vault: ApiKeyVault,
    grant: Awaited<ReturnType<HostedAiClientPort["startAnonymousSession"]>>,
    recoveryToken?: string,
  ): Promise<void> {
    await vault.setApiKey(HOSTED_AI_SESSION_TOKEN_REF, grant.sessionToken);
    if (recoveryToken) await vault.setApiKey(HOSTED_AI_RECOVERY_TOKEN_REF, recoveryToken);
    this.sessionToken = grant.sessionToken;
    const account: HostedAiAccount = {
      accountId: grant.accountId,
      appAccountToken: grant.appAccountToken,
      balance: grant.balance,
      models: grant.models,
      pointPacks: grant.pointPacks,
    };
    this.setSnapshot({ state: "ready", account });
  }

  private setSnapshot(snapshot: HostedAiSessionSnapshot): void {
    this.snapshotValue = cloneSnapshot(snapshot);
    for (const subscriber of this.subscribers) subscriber();
  }
}

function cloneSnapshot(snapshot: HostedAiSessionSnapshot): HostedAiSessionSnapshot {
  return {
    ...snapshot,
    ...(snapshot.account ? {
      account: {
        ...snapshot.account,
        balance: { ...snapshot.account.balance },
        models: snapshot.account.models.map((model) => ({
          ...model,
          capabilities: [...model.capabilities],
        })),
        pointPacks: snapshot.account.pointPacks.map((pointPack) => ({ ...pointPack })),
      },
    } : {}),
  };
}

function publicError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "NKG AI 服务暂时不可用";
}
