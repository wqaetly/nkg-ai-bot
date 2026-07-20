import type { AppPlatform } from "@nkg-ai-bot/runtime-router";
import type { RuntimeCatalogSyncResult } from "./runtimeCatalog";
import type { RuntimeSuspensionResult } from "./runtimeExecutionTracker";

export const MOBILE_SUSPENDED_EVENT = "tauri://suspended";
export const MOBILE_RESUMED_EVENT = "tauri://resumed";

export type MobileRuntimeLifecycleState =
  | { phase: "active" | "degraded"; catalog: RuntimeCatalogSyncResult }
  | { phase: "suspending"; catalog: RuntimeCatalogSyncResult }
  | {
      phase: "suspended";
      catalog: RuntimeCatalogSyncResult;
      suspension: RuntimeSuspensionResult;
    }
  | { phase: "resuming"; catalog: RuntimeCatalogSyncResult }
  | { phase: "failed"; catalog: RuntimeCatalogSyncResult; message: string };

export type LifecycleEventListener = (
  event: string,
  handler: () => void,
) => Promise<() => void>;

export interface MobileRuntimeLifecycleOptions {
  platform: AppPlatform;
  initialCatalog: RuntimeCatalogSyncResult;
  listen: LifecycleEventListener;
  suspendExecutions: () => Promise<RuntimeSuspensionResult>;
  resumeRuntime: () => Promise<RuntimeCatalogSyncResult>;
}

/** Serialises native mobile lifecycle transitions and exposes UI state. */
export class MobileRuntimeLifecycle {
  private stateValue: MobileRuntimeLifecycleState;
  private readonly subscribers = new Set<(state: MobileRuntimeLifecycleState) => void>();
  private unlisten: Array<() => void> = [];
  private queue: Promise<void> = Promise.resolve();
  private started = false;

  constructor(private readonly options: MobileRuntimeLifecycleOptions) {
    this.stateValue = activeState(options.initialCatalog);
  }

  get state(): MobileRuntimeLifecycleState {
    return this.stateValue;
  }

  async start(): Promise<void> {
    if (this.started || !isMobile(this.options.platform)) return;
    const suspended = await this.options.listen(MOBILE_SUSPENDED_EVENT, () => {
      this.enqueue(() => this.suspend());
    });
    try {
      const resumed = await this.options.listen(MOBILE_RESUMED_EVENT, () => {
        this.enqueue(() => this.resume());
      });
      this.unlisten = [suspended, resumed];
      this.started = true;
    } catch (error) {
      suspended();
      throw error;
    }
  }

  subscribe(subscriber: (state: MobileRuntimeLifecycleState) => void): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.stateValue);
    return () => this.subscribers.delete(subscriber);
  }

  stop(): void {
    for (const unlisten of this.unlisten.splice(0)) unlisten();
    this.started = false;
  }

  /** Resolves after all lifecycle events received so far have settled. */
  settled(): Promise<void> {
    return this.queue;
  }

  private enqueue(transition: () => Promise<void>): void {
    this.queue = this.queue.then(transition, transition);
  }

  private async suspend(): Promise<void> {
    if (this.stateValue.phase === "suspended" || this.stateValue.phase === "suspending") return;
    const catalog = this.stateValue.catalog;
    this.publish({ phase: "suspending", catalog });
    try {
      const suspension = await this.options.suspendExecutions();
      this.publish({ phase: "suspended", catalog, suspension });
    } catch (error: unknown) {
      this.publish({
        phase: "failed",
        catalog,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async resume(): Promise<void> {
    const catalog = this.stateValue.catalog;
    this.publish({ phase: "resuming", catalog });
    try {
      this.publish(activeState(await this.options.resumeRuntime()));
    } catch (error: unknown) {
      this.publish({
        phase: "failed",
        catalog,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private publish(state: MobileRuntimeLifecycleState): void {
    this.stateValue = state;
    for (const subscriber of this.subscribers) subscriber(state);
  }
}

function activeState(catalog: RuntimeCatalogSyncResult): MobileRuntimeLifecycleState {
  return {
    phase: catalog.failures.length === 0 ? "active" : "degraded",
    catalog,
  };
}

function isMobile(platform: AppPlatform): boolean {
  return platform === "android" || platform === "ios";
}
