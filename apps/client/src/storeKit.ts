import { addPluginListener, invoke, type PluginListener } from "@tauri-apps/api/core";

export interface StoreKitProduct {
  id: string;
  displayName: string;
  description: string;
  displayPrice: string;
  price: string;
  productType: "consumable" | "unsupported";
}

export interface StoreKitTransaction {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  appAccountToken?: string;
  purchaseDate: string;
  environment: string;
  ownershipType: string;
  signedTransactionInfo: string;
}

export interface StoreKitPurchaseResult {
  status: "purchased" | "pending" | "cancelled";
  transaction?: StoreKitTransaction;
}

export interface StoreKitPort {
  products(productIds: string[]): Promise<StoreKitProduct[]>;
  purchase(productId: string, appAccountToken: string): Promise<StoreKitPurchaseResult>;
  unfinished(): Promise<StoreKitTransaction[]>;
  finish(transactionId: string): Promise<boolean>;
  onTransaction(handler: (transaction: StoreKitTransaction) => void): Promise<() => void>;
}

export class StoreKitClient implements StoreKitPort {
  async products(productIds: string[]): Promise<StoreKitProduct[]> {
    if (!productIds.length) return [];
    return invoke<StoreKitProduct[]>("plugin:storekit|products", {
      payload: { productIds: [...new Set(productIds)] },
    });
  }

  purchase(productId: string, appAccountToken: string): Promise<StoreKitPurchaseResult> {
    return invoke("plugin:storekit|purchase", {
      payload: { productId, appAccountToken },
    });
  }

  unfinished(): Promise<StoreKitTransaction[]> {
    return invoke("plugin:storekit|unfinished");
  }

  async finish(transactionId: string): Promise<boolean> {
    const result = await invoke<{ finished: boolean }>("plugin:storekit|finish", {
      payload: { transactionId },
    });
    return result.finished;
  }

  async onTransaction(handler: (transaction: StoreKitTransaction) => void): Promise<() => void> {
    const listener: PluginListener = await addPluginListener(
      "storekit",
      "transaction",
      (event) => handler((event as { payload: StoreKitTransaction }).payload),
    );
    return () => listener.unregister();
  }
}
