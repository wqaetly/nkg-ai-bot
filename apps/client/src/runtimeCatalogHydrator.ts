import type { RuntimeRouterSnapshot } from "@nkg-ai-bot/runtime-router";
import type { RuntimeCatalogSyncResult } from "./runtimeCatalog";

export interface GenerationRuntime {
  readonly snapshot: Pick<RuntimeRouterSnapshot, "generation">;
  start(): Promise<void>;
}

export type HydrateRuntimeCatalog = () => Promise<RuntimeCatalogSyncResult>;

/**
 * Keeps the in-memory Flow catalog aligned with the current backend instance.
 * A restarted Node sidecar has an empty catalog even though its HTTP endpoint
 * is healthy, so each new router generation must be hydrated before use.
 */
export class RuntimeCatalogHydrator {
  private hydratedGeneration: number;
  private catalogValue: RuntimeCatalogSyncResult;
  private hydrationPromise: Promise<RuntimeCatalogSyncResult> | undefined;

  constructor(
    private readonly runtime: GenerationRuntime,
    private readonly hydrate: HydrateRuntimeCatalog,
    initialCatalog: RuntimeCatalogSyncResult,
  ) {
    this.hydratedGeneration = runtime.snapshot.generation;
    this.catalogValue = initialCatalog;
  }

  get catalog(): RuntimeCatalogSyncResult {
    return this.catalogValue;
  }

  async ensureCurrent(): Promise<RuntimeCatalogSyncResult> {
    await this.runtime.start();
    if (this.runtime.snapshot.generation === this.hydratedGeneration) {
      return this.catalogValue;
    }
    return this.runHydration();
  }

  /** Re-read local storage even when the backend generation did not change. */
  async refresh(): Promise<RuntimeCatalogSyncResult> {
    await this.runtime.start();
    return this.runHydration(true);
  }

  private async runHydration(force = false): Promise<RuntimeCatalogSyncResult> {
    if (this.hydrationPromise) {
      return this.hydrationPromise;
    }

    this.hydrationPromise = this.hydrateStableGeneration(force).finally(() => {
      this.hydrationPromise = undefined;
    });
    return this.hydrationPromise;
  }

  private async hydrateStableGeneration(force: boolean): Promise<RuntimeCatalogSyncResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.runtime.start();
      const targetGeneration = this.runtime.snapshot.generation;
      if (!force && targetGeneration === this.hydratedGeneration) return this.catalogValue;

      const catalog = await this.hydrate();
      if (this.runtime.snapshot.generation === targetGeneration) {
        this.hydratedGeneration = targetGeneration;
        this.catalogValue = catalog;
        return catalog;
      }
      force = true;
    }
    throw new Error("Runtime restarted repeatedly while restoring the local Flow catalog");
  }
}
