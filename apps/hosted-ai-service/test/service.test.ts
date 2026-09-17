import { describe, expect, it, vi } from "vitest";
import type { AppleTransactionVerifier } from "../src/apple.js";
import type { ServiceConfig } from "../src/config.js";
import { HostedAiCommerceService, type CommerceRepositoryPort } from "../src/service.js";

const account = {
  accountId: "05f42572-ddd1-40d2-8d16-d95d23306b75",
  appAccountToken: "4dc0c81e-8604-4c10-8e3c-21d363e1702b",
};
const balance = {
  availablePoints: 600,
  purchasedPoints: 600,
  grantedPoints: 0,
  reservedPoints: 0,
  debtPoints: 0,
  updatedAt: "2026-08-01T00:00:00.000Z",
};
const transaction = {
  transactionId: "2000000123456789",
  originalTransactionId: "2000000123456789",
  appAccountToken: account.appAccountToken,
  productId: "com.nkg.ai.bot.points.600",
  environment: "Sandbox" as const,
  purchaseDate: "2026-08-01T00:00:00.000Z",
};

function setup() {
  const config: ServiceConfig = {
    port: 8787,
    databaseUrl: "postgres://test",
    publicBaseUrl: "https://api.example.test",
    sessionDays: 30,
    runTtlSeconds: 300,
    welcomeGrantPoints: 100,
    runTokenSecret: "x".repeat(32),
    newApiBaseUrl: "https://new-api.example.test",
    newApiKey: "new-api-secret",
    searxngBaseUrl: "https://search.example.test",
    searxngApiKey: "search-secret",
    searchTimeoutMs: 12_000,
    searchMaxResults: 6,
    appleBundleId: "com.nkg.ai.bot",
    appleAppId: 123456789,
    appleRootCertificates: [],
    models: [{
      id: "nkg-fast",
      name: "NKG Fast",
      contextWindow: 128_000,
      inputPointsPerMillionTokens: 100,
      outputPointsPerMillionTokens: 500,
      reservePoints: 50,
      capabilities: ["text"],
    }, {
      id: "nkg-pro",
      name: "NKG Pro",
      contextWindow: 200_000,
      inputPointsPerMillionTokens: 300,
      outputPointsPerMillionTokens: 1_000,
      reservePoints: 80,
      capabilities: ["text", "reasoning"],
    }],
    pointPacks: [{
      id: "points-600",
      points: 600,
      appleProductId: transaction.productId,
      featured: true,
    }],
  };
  const repository: CommerceRepositoryPort = {
    startAnonymousSession: vi.fn(async () => ({
      ...account,
      sessionToken: "nkg_sess_secret",
      sessionExpiresAt: "2026-09-01T00:00:00.000Z",
      balance,
      recoveryToken: `nkg_recover_${"r".repeat(43)}`,
    })),
    recoverAnonymousSession: vi.fn(async () => ({
      ...account,
      sessionToken: "nkg_sess_recovered",
      sessionExpiresAt: "2026-09-01T00:00:00.000Z",
      balance,
    })),
    authenticateSession: vi.fn(async () => account),
    getBalance: vi.fn(async () => balance),
    authorizeRun: vi.fn(async () => ({
      run: {
        id: "48c1c384-013f-402b-ac19-b42bd0dccb37",
        accountId: account.accountId,
        requestId: "b130c491-0f3a-4491-a30a-7a281026a42b",
        flowId: "builtin.chat",
        modelId: "nkg-fast",
        reservedPoints: 50,
        chargedPoints: 0,
        status: "authorized",
        expiresAt: "2026-08-01T00:05:00.000Z",
      },
      apiKey: "nkg_run_secret",
      balance: { ...balance, availablePoints: 550, reservedPoints: 50 },
    })),
    completeRun: vi.fn(async () => balance),
    creditApplePurchase: vi.fn(async () => ({
      transactionId: transaction.transactionId,
      creditedPoints: 600,
      balance,
    })),
    applyAppleRevocation: vi.fn(async () => undefined),
    rotateRecoveryToken: vi.fn(async () => `nkg_recover_${"n".repeat(43)}`),
  };
  const apple: AppleTransactionVerifier = {
    verifyTransaction: vi.fn(async () => transaction),
    verifyNotification: vi.fn(async () => ({
      notificationType: "REFUND",
      notificationUuid: "notification-1",
      transaction: { ...transaction, revokedAt: "2026-08-02T00:00:00.000Z" },
    })),
  };
  return { service: new HostedAiCommerceService(config, repository, apple), repository, apple };
}

describe("HostedAiCommerceService", () => {
  it("returns only public balance fields and server-owned catalogs", async () => {
    const { service } = setup();
    const result = await service.getAccount("nkg_sess_secret");
    expect(result).toMatchObject({
      ...account,
      balance: { availablePoints: 600, purchasedPoints: 600, grantedPoints: 0 },
      models: [
        { id: "nkg-fast", inputPointsPerMillionTokens: 100 },
        { id: "nkg-pro", inputPointsPerMillionTokens: 300 },
      ],
      pointPacks: [{ id: "points-600", points: 600 }],
    });
    expect(result.balance).not.toHaveProperty("debtPoints");
    expect(result.models[0]).not.toHaveProperty("reservePoints");
  });

  it("recovers permanent points with a high-entropy recovery code", async () => {
    const { service, repository } = setup();
    await expect(service.recoverAnonymousSession({
      recoveryToken: `nkg_recover_${"r".repeat(43)}`,
      installationId: "b130c491-0f3a-4491-a30a-7a281026a42b",
      platform: "ios",
      appVersion: "1.0.0",
    })).resolves.toMatchObject({ accountId: account.accountId, sessionToken: "nkg_sess_recovered" });
    expect(repository.recoverAnonymousSession).toHaveBeenCalledWith(expect.objectContaining({
      recoveryToken: `nkg_recover_${"r".repeat(43)}`,
    }));
    await expect(service.rotateRecoveryToken("nkg_sess_secret")).resolves.toMatchObject({
      recoveryToken: `nkg_recover_${"n".repeat(43)}`,
    });
  });

  it("authorizes a run only when the header and request UUID agree", async () => {
    const { service, repository } = setup();
    const requestId = "b130c491-0f3a-4491-a30a-7a281026a42b";
    await expect(service.authorizeRun("nkg_sess_secret", {
      requestId,
      flowId: "builtin.chat",
      modelId: "nkg-fast",
    }, requestId)).resolves.toMatchObject({
      apiBaseUrl: "https://api.example.test/api/app/v1/gateway/v1",
      apiKey: "nkg_run_secret",
      balance: { availablePoints: 550 },
    });
    expect(repository.authorizeRun).toHaveBeenCalledWith(expect.objectContaining({
      accountId: account.accountId,
      requestId,
      model: expect.objectContaining({ id: "nkg-fast", reservePoints: 50 }),
    }));
    await expect(service.authorizeRun("nkg_sess_secret", {
      requestId,
      flowId: "builtin.chat",
      modelId: "nkg-fast",
    }, "bad-key")).rejects.toMatchObject({ code: "invalid_idempotency_key" });
  });

  it("releases unused reservation when the workflow reports completion", async () => {
    const { service, repository } = setup();
    await expect(service.completeRun("nkg_sess_secret", {
      authorizationId: "48c1c384-013f-402b-ac19-b42bd0dccb37",
    })).resolves.toMatchObject({ balance: { availablePoints: 600 } });
    expect(repository.completeRun).toHaveBeenCalledWith(
      account.accountId,
      "48c1c384-013f-402b-ac19-b42bd0dccb37",
    );
  });

  it("verifies Apple JWS before crediting the configured point pack", async () => {
    const { service, repository, apple } = setup();
    const signedTransactionInfo = "x".repeat(80);
    await service.redeemApplePurchase("nkg_sess_secret", {
      appAccountToken: account.appAccountToken,
      signedTransactionInfo,
    });
    expect(apple.verifyTransaction).toHaveBeenCalledWith(signedTransactionInfo);
    expect(repository.creditApplePurchase).toHaveBeenCalledWith(expect.objectContaining({
      account,
      transaction,
      pointPack: expect.objectContaining({ points: 600 }),
    }));
  });

  it("turns verified refund notifications into idempotent ledger revocations", async () => {
    const { service, repository } = setup();
    const signedPayload = "n".repeat(80);
    await expect(service.handleAppleNotification({ signedPayload })).resolves.toEqual({ accepted: true });
    expect(repository.applyAppleRevocation).toHaveBeenCalledWith(expect.objectContaining({
      signedPayload,
      pointPack: expect.objectContaining({ id: "points-600" }),
    }));
  });
});
