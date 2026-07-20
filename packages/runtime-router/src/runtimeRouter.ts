import type {
  RuntimeBackend,
  RuntimeBackendKind,
  RuntimeRouterOptions,
  RuntimeRouterSnapshot,
  RuntimeRouterState,
} from "./contracts.js";
import { RuntimeTransportError } from "./contracts.js";
import { selectRuntimeBackend } from "./platform.js";

export class RuntimeRouter {
  readonly platform: RuntimeRouterOptions["platform"];
  readonly backendKind: RuntimeBackendKind;

  private stateValue: RuntimeRouterState = "idle";
  private backend: RuntimeBackend | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private recoveryPromise: Promise<void> | undefined;
  private failure: Error | undefined;
  private generationValue = 0;
  private readonly responseBackends = new WeakMap<Response, RuntimeBackend>();

  constructor(private readonly options: RuntimeRouterOptions) {
    this.platform = options.platform;
    this.backendKind = selectRuntimeBackend(options.platform);
  }

  get snapshot(): RuntimeRouterSnapshot {
    return {
      platform: this.platform,
      backend: this.backendKind,
      state: this.stateValue,
      generation: this.generationValue,
      ...(this.failure ? { error: this.failure } : {}),
    };
  }

  async start(): Promise<void> {
    if (this.stateValue === "ready") return;
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) await this.stopPromise;
    if (this.recoveryPromise) await this.recoveryPromise;

    this.stateValue = "starting";
    this.failure = undefined;
    const factory = this.backendKind === "node-sidecar"
      ? this.options.desktop
      : this.options.mobile;

    this.startPromise = (async () => {
      const backend = await factory();
      if (backend.kind !== this.backendKind) {
        throw new Error(
          `Runtime backend mismatch: expected ${this.backendKind}, received ${backend.kind}`,
        );
      }
      this.backend = backend;
      await backend.start();
      this.generationValue += 1;
      this.stateValue = "ready";
    })().catch(async (cause: unknown) => {
      const error = toError(cause);
      this.failure = error;
      this.stateValue = "failed";
      const failedBackend = this.backend;
      this.backend = undefined;
      await failedBackend?.stop().catch(() => undefined);
      throw error;
    }).finally(() => {
      this.startPromise = undefined;
    });

    return this.startPromise;
  }

  async request(path: string, init?: RequestInit): Promise<Response> {
    await this.start();
    if (!this.backend || this.stateValue !== "ready") {
      throw new Error("Runtime router did not reach ready state");
    }
    const backend = this.backend;
    try {
      const response = await backend.request(path, init);
      this.responseBackends.set(response, backend);
      return response;
    } catch (cause: unknown) {
      const error = toError(cause);
      if (this.backendKind === "node-sidecar" && !isAbort(error, init?.signal)) {
        const interruption = new RuntimeTransportError(
          `Desktop runtime connection was interrupted: ${error.message}`,
          {
            backend: this.backendKind,
            phase: "request",
            requestMayHaveExecuted: isPotentiallyMutating(init?.method),
            cause: error,
          },
        );
        await this.invalidateBackend(backend, interruption);
        throw interruption;
      }
      throw error;
    }
  }

  /**
   * Marks the backend that produced a response as stale when consuming that
   * response later fails. Response provenance prevents an old stream from
   * invalidating a replacement backend started concurrently.
   */
  async reportResponseFailure(
    response: Response,
    cause: Error,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.backendKind !== "node-sidecar" || isAbort(cause, signal)) return;
    const backend = this.responseBackends.get(response);
    if (!backend) return;
    await this.invalidateBackend(backend, cause);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.recoveryPromise) await this.recoveryPromise;
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }
    if (!this.backend) {
      if (this.stateValue !== "failed") this.stateValue = "idle";
      return;
    }

    this.stateValue = "stopping";
    const backend = this.backend;
    this.backend = undefined;
    this.stopPromise = backend.stop().then(() => {
      this.stateValue = "idle";
      this.failure = undefined;
    }).catch((cause: unknown) => {
      const error = toError(cause);
      this.failure = error;
      this.stateValue = "failed";
      throw error;
    }).finally(() => {
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }

  /**
   * A failed desktop fetch normally means the child process or its loopback
   * socket disappeared. Never replay the failed request (POST may have caused
   * a side effect); dispose the stale backend so the next user action starts a
   * fresh sidecar instead.
   */
  private async invalidateBackend(backend: RuntimeBackend, error: Error): Promise<void> {
    if (this.backend !== backend) return;
    this.backend = undefined;
    this.stateValue = "failed";
    this.failure = error;
    this.recoveryPromise ??= backend.stop()
      .catch(() => undefined)
      .finally(() => {
        this.recoveryPromise = undefined;
      });
    await this.recoveryPromise;
  }
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function isAbort(error: Error, signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true || error.name === "AbortError";
}

function isPotentiallyMutating(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}
