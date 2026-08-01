import {
  Environment,
  SignedDataVerifier,
  Type,
  type JWSTransactionDecodedPayload,
} from "@apple/app-store-server-library";
import { CommerceDomainError, type AppleTransaction } from "./domain.js";

export interface AppleTransactionVerifier {
  verifyTransaction(signedTransactionInfo: string): Promise<AppleTransaction>;
  verifyNotification(signedPayload: string): Promise<{
    notificationType: string;
    notificationUuid: string;
    transaction?: AppleTransaction;
  }>;
}

export class OfficialAppleTransactionVerifier implements AppleTransactionVerifier {
  private readonly production: SignedDataVerifier;
  private readonly sandbox: SignedDataVerifier;

  constructor(input: {
    rootCertificates: Buffer[];
    bundleId: string;
    appAppleId: number;
    enableOnlineChecks?: boolean;
  }) {
    const online = input.enableOnlineChecks ?? true;
    this.production = new SignedDataVerifier(
      input.rootCertificates,
      online,
      Environment.PRODUCTION,
      input.bundleId,
      input.appAppleId,
    );
    this.sandbox = new SignedDataVerifier(
      input.rootCertificates,
      online,
      Environment.SANDBOX,
      input.bundleId,
    );
  }

  async verifyTransaction(signedTransactionInfo: string): Promise<AppleTransaction> {
    if (signedTransactionInfo.length < 64 || signedTransactionInfo.length > 64_000) {
      throw new CommerceDomainError("invalid_apple_transaction", "App Store 交易数据无效", 400);
    }
    const payload = await this.verifyWithEitherEnvironment(
      (verifier) => verifier.verifyAndDecodeTransaction(signedTransactionInfo),
      "App Store 交易验证失败",
    );
    return mapTransaction(payload);
  }

  async verifyNotification(signedPayload: string): Promise<{
    notificationType: string;
    notificationUuid: string;
    transaction?: AppleTransaction;
  }> {
    if (signedPayload.length < 64 || signedPayload.length > 128_000) {
      throw new CommerceDomainError("invalid_apple_notification", "App Store 通知数据无效", 400);
    }
    const { value: notification, verifier } = await this.verifyWithEitherEnvironmentAndVerifier(
      (candidate) => candidate.verifyAndDecodeNotification(signedPayload),
      "App Store 通知验证失败",
    );
    const signedTransactionInfo = notification.data?.signedTransactionInfo;
    const transaction = signedTransactionInfo
      ? mapTransaction(await verifier.verifyAndDecodeTransaction(signedTransactionInfo))
      : undefined;
    if (!notification.notificationType || !notification.notificationUUID) {
      throw new CommerceDomainError("incomplete_apple_notification", "App Store 通知缺少必要字段", 400);
    }
    return {
      notificationType: notification.notificationType,
      notificationUuid: notification.notificationUUID,
      ...(transaction ? { transaction } : {}),
    };
  }

  private async verifyWithEitherEnvironment<T>(
    action: (verifier: SignedDataVerifier) => Promise<T>,
    message: string,
  ): Promise<T> {
    return (await this.verifyWithEitherEnvironmentAndVerifier(action, message)).value;
  }

  private async verifyWithEitherEnvironmentAndVerifier<T>(
    action: (verifier: SignedDataVerifier) => Promise<T>,
    message: string,
  ): Promise<{ value: T; verifier: SignedDataVerifier }> {
    try {
      return { value: await action(this.production), verifier: this.production };
    } catch (productionError) {
      try {
        return { value: await action(this.sandbox), verifier: this.sandbox };
      } catch (sandboxError) {
        throw new CommerceDomainError(
          "apple_verification_failed",
          message,
          isRetryableVerification(productionError) || isRetryableVerification(sandboxError) ? 503 : 400,
        );
      }
    }
  }
}

function mapTransaction(payload: JWSTransactionDecodedPayload): AppleTransaction {
  if (!payload.transactionId || !payload.originalTransactionId || !payload.productId
    || !payload.appAccountToken || !payload.purchaseDate) {
    throw new CommerceDomainError("incomplete_apple_transaction", "App Store 交易缺少必要字段", 400);
  }
  if (payload.type !== Type.CONSUMABLE || payload.quantity !== 1) {
    throw new CommerceDomainError("invalid_product_type", "点数商品必须是单件消耗型内购", 400);
  }
  if (payload.environment !== Environment.PRODUCTION && payload.environment !== Environment.SANDBOX) {
    throw new CommerceDomainError("invalid_apple_environment", "App Store 交易环境无效", 400);
  }
  return {
    transactionId: payload.transactionId,
    originalTransactionId: payload.originalTransactionId,
    productId: payload.productId,
    appAccountToken: payload.appAccountToken.toLowerCase(),
    environment: payload.environment,
    purchaseDate: new Date(payload.purchaseDate).toISOString(),
    ...(payload.revocationDate ? { revokedAt: new Date(payload.revocationDate).toISOString() } : {}),
  };
}

function isRetryableVerification(error: unknown): boolean {
  const status = error && typeof error === "object" && "status" in error
    ? String((error as { status: unknown }).status)
    : "";
  return status.includes("RETRYABLE") || status.includes("INVALID_CERTIFICATE");
}
