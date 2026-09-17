import { describe, expect, it, vi } from "vitest";
import type { HostedAiAccount } from "../src/hostedAi";
import { HostedAiPurchaseController } from "../src/hostedAiPurchases";
import { HostedAiSession, type HostedAiClientPort } from "../src/hostedAiSession";
import type { ApiKeyVault } from "../src/storage/secretVault";
import type { StoreKitPort, StoreKitTransaction } from "../src/storeKit";

const appAccountToken = "4dc0c81e-8604-4c10-8e3c-21d363e1702b";
const account: HostedAiAccount = {
  accountId: "account-1",
  appAccountToken,
  balance: { availablePoints: 100, purchasedPoints: 0, grantedPoints: 100, updatedAt: "2026-08-01T00:00:00.000Z" },
  models: [{ id: "nkg-fast", name: "NKG Fast", contextWindow: 128_000, inputPointsPerMillionTokens: 100, outputPointsPerMillionTokens: 500, capabilities: ["text"] }],
  pointPacks: [{ id: "points-600", points: 600, appleProductId: "top.lfzxb.nkg.points600", featured: true }],
};

class Vault implements ApiKeyVault {
  value: string | undefined;
  async setApiKey(_reference: string, value: string) { this.value = value; }
  async getApiKey() { return this.value; }
  async removeApiKey() { this.value = undefined; }
  async lock() {}
}

function transaction(overrides: Partial<StoreKitTransaction> = {}): StoreKitTransaction {
  return {
    transactionId: "2000000123456789",
    originalTransactionId: "2000000123456789",
    productId: "top.lfzxb.nkg.points600",
    appAccountToken,
    purchaseDate: "2026-08-01T00:00:00.000Z",
    environment: "Sandbox",
    ownershipType: "purchased",
    signedTransactionInfo: "signed-apple-transaction-payload",
    ...overrides,
  };
}

async function setup(unfinished: StoreKitTransaction[] = []) {
  const redeemApplePurchase = vi.fn(async () => ({
    transactionId: "2000000123456789",
    creditedPoints: 600,
    balance: { ...account.balance, availablePoints: 700, purchasedPoints: 600 },
  }));
  const client: HostedAiClientPort = {
    startAnonymousSession: vi.fn(async () => ({ ...account, sessionToken: "session-token", sessionExpiresAt: "2026-09-01T00:00:00.000Z" })),
    getAccount: vi.fn(async () => account),
    recoverAnonymousSession: vi.fn(async () => ({ ...account, sessionToken: "session-token", sessionExpiresAt: "2026-09-01T00:00:00.000Z" })),
    rotateRecoveryToken: vi.fn(async () => `nkg_recover_${"r".repeat(43)}`),
    createRunOptions: vi.fn(),
    completeRun: vi.fn(async () => account.balance),
    redeemApplePurchase,
    searchWeb: vi.fn(async () => []),
  };
  const hosted = new HostedAiSession(client, { getInstallationId: async () => "b130c491-0f3a-4491-a30a-7a281026a42b", setInstallationId: async () => undefined });
  await hosted.initialize(new Vault(), { platform: "ios", appVersion: "0.1.0" });
  const finish = vi.fn(async () => true);
  const storeKit: StoreKitPort = {
    products: vi.fn(async () => [{ id: "top.lfzxb.nkg.points600", displayName: "600 AI 点数", description: "NKG AI 点数", displayPrice: "¥6.00", price: "6", productType: "consumable" }]),
    purchase: vi.fn(async () => ({ status: "purchased", transaction: transaction() })),
    unfinished: vi.fn(async () => unfinished),
    finish,
    onTransaction: vi.fn(async () => () => undefined),
  };
  return { controller: new HostedAiPurchaseController(storeKit, hosted), redeemApplePurchase, finish, storeKit, hosted };
}

describe("HostedAiPurchaseController", () => {
  it("loads only server-configured consumable point packs", async () => {
    const { controller } = await setup();
    await controller.initialize();
    expect(controller.snapshot).toMatchObject({
      state: "ready",
      products: [{ id: "points-600", points: 600, displayPrice: "¥6.00" }],
    });
  });

  it("credits the server ledger before finishing a StoreKit transaction", async () => {
    const { controller, redeemApplePurchase, finish } = await setup();
    await controller.initialize();
    await controller.purchase("points-600");
    expect(redeemApplePurchase).toHaveBeenCalledWith(
      "session-token",
      { appAccountToken, signedTransactionInfo: "signed-apple-transaction-payload" },
      undefined,
    );
    expect(finish).toHaveBeenCalledWith("2000000123456789");
    expect(controller.snapshot.message).toBe("AI 点数已到账");
  });

  it("recovers unfinished purchases after a crash", async () => {
    const { controller, redeemApplePurchase, finish } = await setup([transaction()]);
    await controller.initialize();
    expect(redeemApplePurchase).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("does not finish a transaction when server crediting fails", async () => {
    const { controller, storeKit, finish } = await setup();
    (storeKit.purchase as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "purchased", transaction: transaction() });
    await controller.initialize();
    const hostedSession = (controller as unknown as { hostedSession: HostedAiSession }).hostedSession;
    vi.spyOn(hostedSession, "redeemApplePurchase").mockRejectedValue(new Error("network"));
    await expect(controller.purchase("points-600")).rejects.toThrow("network");
    expect(finish).not.toHaveBeenCalled();
  });

  it("ignores transactions assigned to another app account", async () => {
    const { controller, redeemApplePurchase, finish } = await setup([
      transaction({ appAccountToken: "83d94a7d-a0a5-429b-9269-487a2948f974" }),
    ]);
    await controller.initialize();
    expect(redeemApplePurchase).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });
});
