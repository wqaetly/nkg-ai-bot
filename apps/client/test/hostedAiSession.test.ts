import { describe, expect, it, vi } from "vitest";
import {
  HOSTED_AI_SESSION_TOKEN_REF,
  HOSTED_AI_RECOVERY_TOKEN_REF,
  HostedAiApiError,
  type HostedAiAccount,
  type HostedAiSessionGrant,
} from "../src/hostedAi";
import {
  HostedAiSession,
  type HostedAiClientPort,
  type HostedAiInstallationStore,
} from "../src/hostedAiSession";
import type { ApiKeyVault } from "../src/storage/secretVault";

const account: HostedAiAccount = {
  accountId: "account-1",
  appAccountToken: "4dc0c81e-8604-4c10-8e3c-21d363e1702b",
  balance: {
    availablePoints: 300,
    purchasedPoints: 0,
    grantedPoints: 300,
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  models: [{
    id: "nkg-fast",
    name: "NKG Fast",
    contextWindow: 128_000,
    inputPointsPerMillionTokens: 100,
    outputPointsPerMillionTokens: 500,
    capabilities: ["text"],
  }],
  pointPacks: [],
};

class MemoryVault implements ApiKeyVault {
  readonly values = new Map<string, string>();
  async setApiKey(reference: string, apiKey: string) { this.values.set(reference, apiKey); }
  async getApiKey(reference: string) { return this.values.get(reference); }
  async removeApiKey(reference: string) { this.values.delete(reference); }
  async lock() {}
}

class MemoryInstallationStore implements HostedAiInstallationStore {
  installationId: string | undefined;
  async getInstallationId() { return this.installationId; }
  async setInstallationId(installationId: string) { this.installationId = installationId; }
}

function client(overrides: Partial<HostedAiClientPort> = {}): HostedAiClientPort {
  const grant: HostedAiSessionGrant = {
    ...account,
    sessionToken: "new-session-token",
    sessionExpiresAt: "2026-09-01T00:00:00.000Z",
    recoveryToken: `nkg_recover_${"r".repeat(43)}`,
  };
  return {
    startAnonymousSession: vi.fn(async () => grant),
    getAccount: vi.fn(async () => account),
    recoverAnonymousSession: vi.fn(async () => grant),
    rotateRecoveryToken: vi.fn(async () => `nkg_recover_${"n".repeat(43)}`),
    createRunOptions: vi.fn(async (_token, input, options = {}) => ({
      options: {
        ...options,
        envOverrides: {
          variables: {
            ...options.envOverrides?.variables,
            LLM_BASE_URL: "https://api.example.test/v1",
            LLM_DEFAULT_MODEL: input.modelId,
          },
          secrets: { LLM_API_KEY: "run-secret" },
        },
      },
      authorization: {
        authorizationId: "auth-1",
        apiBaseUrl: "https://api.example.test/v1",
        apiKey: "run-secret",
        expiresAt: "2026-08-01T00:05:00.000Z",
        balance: { ...account.balance, availablePoints: 280 },
      },
    })),
    completeRun: vi.fn(async () => account.balance),
    redeemApplePurchase: vi.fn(async () => ({
      transactionId: "tx-1",
      creditedPoints: 600,
      balance: { ...account.balance, availablePoints: 900, purchasedPoints: 600 },
    })),
    ...overrides,
  };
}

describe("HostedAiSession", () => {
  it("creates and persists one anonymous installation and session", async () => {
    const vault = new MemoryVault();
    const store = new MemoryInstallationStore();
    const api = client();
    const session = new HostedAiSession(api, store);

    await expect(session.initialize(vault, { platform: "ios", appVersion: "0.1.0" }))
      .resolves.toMatchObject({ state: "ready", account: { accountId: "account-1" } });
    expect(store.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(vault.values.get(HOSTED_AI_SESSION_TOKEN_REF)).toBe("new-session-token");
    expect(vault.values.get(HOSTED_AI_RECOVERY_TOKEN_REF)).toBe(`nkg_recover_${"r".repeat(43)}`);
    expect(api.startAnonymousSession).toHaveBeenCalledWith(expect.objectContaining({
      installationId: store.installationId,
      platform: "ios",
    }), undefined);
  });

  it("restores an existing server session without creating a second account", async () => {
    const vault = new MemoryVault();
    vault.values.set(HOSTED_AI_SESSION_TOKEN_REF, "stored-session-token");
    const api = client();
    const session = new HostedAiSession(api, new MemoryInstallationStore());

    await session.initialize(vault, { platform: "android", appVersion: "0.1.0" });

    expect(api.getAccount).toHaveBeenCalledWith("stored-session-token", undefined);
    expect(api.startAnonymousSession).not.toHaveBeenCalled();
  });

  it("replaces an expired token and keeps the point balance server-authoritative", async () => {
    const vault = new MemoryVault();
    vault.values.set(HOSTED_AI_SESSION_TOKEN_REF, "expired-session-token");
    const api = client({
      getAccount: vi.fn(async () => {
        throw new HostedAiApiError("expired", 401, "expired", false);
      }),
    });
    const session = new HostedAiSession(api, new MemoryInstallationStore());

    await session.initialize(vault, { platform: "ios", appVersion: "0.1.0" });

    expect(vault.values.get(HOSTED_AI_SESSION_TOKEN_REF)).toBe("new-session-token");
    expect(session.snapshot.account?.balance.availablePoints).toBe(300);
  });

  it("updates the visible balance only from run authorization and purchase responses", async () => {
    const vault = new MemoryVault();
    const session = new HostedAiSession(client(), new MemoryInstallationStore());
    await session.initialize(vault, { platform: "ios", appVersion: "0.1.0" });

    await session.createRunOptions({
      requestId: "request-1",
      flowId: "builtin.chat",
      modelId: "nkg-fast",
    });
    expect(session.snapshot.account?.balance.availablePoints).toBe(280);

    await session.redeemApplePurchase({
      appAccountToken: "4dc0c81e-8604-4c10-8e3c-21d363e1702b",
      signedTransactionInfo: "signed-apple-transaction-payload",
    });
    expect(session.snapshot.account?.balance).toMatchObject({
      availablePoints: 900,
      purchasedPoints: 600,
    });
  });

  it("removes an expired session immediately when run authorization returns 401", async () => {
    const vault = new MemoryVault();
    const api = client({
      createRunOptions: vi.fn(async () => {
        throw new HostedAiApiError("expired", 401, "invalid_session", false);
      }),
    });
    const session = new HostedAiSession(api, new MemoryInstallationStore());
    await session.initialize(vault, { platform: "ios", appVersion: "0.1.0" });

    await expect(session.createRunOptions({
      requestId: "request-1",
      flowId: "builtin.chat",
      modelId: "nkg-fast",
    })).rejects.toMatchObject({ status: 401 });
    expect(vault.values.has(HOSTED_AI_SESSION_TOKEN_REF)).toBe(false);
    expect(session.snapshot).toMatchObject({ state: "unavailable", error: "expired" });
  });

  it("recovers the same permanent point account on another installation", async () => {
    const vault = new MemoryVault();
    const store = new MemoryInstallationStore();
    const api = client();
    const session = new HostedAiSession(api, store);
    await session.initialize(vault, { platform: "ios", appVersion: "0.1.0" });
    const recoveryCode = `nkg_recover_${"r".repeat(43)}`;

    await session.recoverAccount(recoveryCode);

    expect(api.recoverAnonymousSession).toHaveBeenCalledWith(expect.objectContaining({
      recoveryToken: recoveryCode,
      installationId: store.installationId,
    }), undefined);
    expect(await session.getOrCreateRecoveryToken()).toBe(recoveryCode);
  });
});
