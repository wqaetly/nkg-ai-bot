import type { HostedAiPointPack, HostedAiPurchaseResult } from "./hostedAi";
import type { HostedAiSession } from "./hostedAiSession";
import type {
  StoreKitPort,
  StoreKitProduct,
  StoreKitPurchaseResult,
  StoreKitTransaction,
} from "./storeKit";

export type HostedAiPurchaseState = "idle" | "loading" | "ready" | "purchasing" | "error";

export interface HostedAiPointProduct extends HostedAiPointPack {
  displayName: string;
  description: string;
  displayPrice: string;
}

export interface HostedAiPurchasesSnapshot {
  state: HostedAiPurchaseState;
  products: HostedAiPointProduct[];
  purchasingPackId?: string;
  message?: string;
  error?: string;
}

/**
 * Coordinates StoreKit delivery with the server ledger. A transaction is only
 * finished after the commerce API has accepted it, so a crash or network error
 * leaves it in StoreKit's unfinished queue for a later retry.
 */
export class HostedAiPurchaseController {
  private snapshotValue: HostedAiPurchasesSnapshot = { state: "idle", products: [] };
  private readonly subscribers = new Set<() => void>();
  private readonly processing = new Map<string, Promise<HostedAiPurchaseResult | undefined>>();
  private unsubscribeTransaction: (() => void) | undefined;
  private initialization: Promise<HostedAiPurchasesSnapshot> | undefined;
  private catalogKey = "";

  constructor(
    private readonly storeKit: StoreKitPort,
    private readonly hostedSession: HostedAiSession,
  ) {}

  get snapshot(): HostedAiPurchasesSnapshot {
    return { ...this.snapshotValue, products: this.snapshotValue.products.map((item) => ({ ...item })) };
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  initialize(): Promise<HostedAiPurchasesSnapshot> {
    this.initialization ??= this.connect().finally(() => { this.initialization = undefined; });
    return this.initialization;
  }

  async purchase(packId: string): Promise<StoreKitPurchaseResult> {
    const account = this.requireAccount();
    const product = this.snapshotValue.products.find((item) => item.id === packId);
    if (!product) throw new Error("这个 AI 点数商品当前不可购买");
    this.setSnapshot({
      state: "purchasing",
      products: this.snapshotValue.products,
      purchasingPackId: packId,
    });
    try {
      const result = await this.storeKit.purchase(product.appleProductId, account.appAccountToken);
      if (result.status === "purchased") {
        if (!result.transaction) throw new Error("App Store 没有返回购买交易");
        await this.processTransaction(result.transaction);
        this.setSnapshot({ state: "ready", products: this.snapshotValue.products, message: "AI 点数已到账" });
      } else if (result.status === "pending") {
        this.setSnapshot({ state: "ready", products: this.snapshotValue.products, message: "购买正在等待 App Store 批准" });
      } else {
        this.setSnapshot({ state: "ready", products: this.snapshotValue.products });
      }
      return result;
    } catch (cause) {
      this.setSnapshot({
        state: "error",
        products: this.snapshotValue.products,
        error: publicError(cause),
      });
      throw cause;
    }
  }

  lock(): void {
    this.unsubscribeTransaction?.();
    this.unsubscribeTransaction = undefined;
    this.catalogKey = "";
    this.setSnapshot({ state: "idle", products: [] });
  }

  private async connect(): Promise<HostedAiPurchasesSnapshot> {
    const account = this.requireAccount();
    const catalogKey = `${account.appAccountToken}|${account.pointPacks
      .map((pack) => `${pack.id}:${pack.appleProductId}:${pack.points}`)
      .sort()
      .join("|")}`;
    if (this.snapshotValue.state === "ready" && catalogKey === this.catalogKey) return this.snapshot;
    this.setSnapshot({ state: "loading", products: this.snapshotValue.products });
    try {
      this.unsubscribeTransaction ??= await this.storeKit.onTransaction((transaction) => {
        void this.processTransaction(transaction).catch((cause: unknown) => {
          this.setSnapshot({
            state: "error",
            products: this.snapshotValue.products,
            error: publicError(cause),
          });
        });
      });
      const products = await this.loadProducts(account.pointPacks);
      this.catalogKey = catalogKey;
      this.setSnapshot({ state: "ready", products });
      const unfinished = await this.storeKit.unfinished();
      for (const transaction of unfinished) await this.processTransaction(transaction);
      return this.snapshot;
    } catch (cause) {
      this.setSnapshot({ state: "error", products: [], error: publicError(cause) });
      return this.snapshot;
    }
  }

  private async loadProducts(pointPacks: HostedAiPointPack[]): Promise<HostedAiPointProduct[]> {
    if (!pointPacks.length) return [];
    const storeProducts = await this.storeKit.products(pointPacks.map((item) => item.appleProductId));
    const storeById = new Map(storeProducts
      .filter((item) => item.productType === "consumable")
      .map((item) => [item.id, item]));
    return pointPacks.flatMap((pack) => {
      const storeProduct = storeById.get(pack.appleProductId);
      return storeProduct ? [mergeProduct(pack, storeProduct)] : [];
    });
  }

  private processTransaction(
    transaction: StoreKitTransaction,
  ): Promise<HostedAiPurchaseResult | undefined> {
    const existing = this.processing.get(transaction.transactionId);
    if (existing) return existing;
    const processing = this.deliverTransaction(transaction)
      .finally(() => this.processing.delete(transaction.transactionId));
    this.processing.set(transaction.transactionId, processing);
    return processing;
  }

  private async deliverTransaction(
    transaction: StoreKitTransaction,
  ): Promise<HostedAiPurchaseResult | undefined> {
    const account = this.requireAccount();
    const knownProduct = account.pointPacks.some(
      (item) => item.appleProductId === transaction.productId,
    );
    if (!knownProduct || transaction.appAccountToken?.toLowerCase() !== account.appAccountToken) {
      return undefined;
    }
    const result = await this.hostedSession.redeemApplePurchase({
      appAccountToken: account.appAccountToken,
      signedTransactionInfo: transaction.signedTransactionInfo,
    });
    await this.storeKit.finish(transaction.transactionId);
    return result;
  }

  private requireAccount() {
    const snapshot = this.hostedSession.snapshot;
    if (snapshot.state !== "ready" || !snapshot.account) {
      throw new Error("NKG AI 账户尚未连接");
    }
    return snapshot.account;
  }

  private setSnapshot(snapshot: HostedAiPurchasesSnapshot): void {
    this.snapshotValue = {
      ...snapshot,
      products: snapshot.products.map((item) => ({ ...item })),
    };
    for (const subscriber of this.subscribers) subscriber();
  }
}

function mergeProduct(
  pack: HostedAiPointPack,
  product: StoreKitProduct,
): HostedAiPointProduct {
  return {
    ...pack,
    displayName: product.displayName,
    description: product.description,
    displayPrice: product.displayPrice,
  };
}

function publicError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "App Store 购买暂时不可用";
}
