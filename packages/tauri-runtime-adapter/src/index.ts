import {
  FlowRuntimeClient,
  RuntimeRouter,
  createInProcessBackend,
  createNodeSidecarBackend,
  type AppPlatform,
  type RuntimeMode,
  type RuntimeHttpHandler,
  type SidecarDescriptor,
  type SidecarLauncher,
} from "@nkg-ai-bot/runtime-router";

export type TauriInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export interface TauriSidecarLauncherOptions {
  invoke: TauriInvoke;
  startCommand?: string;
  stopCommand?: string;
}

export interface CreateTauriRuntimeOptions {
  platform: AppPlatform;
  mode?: RuntimeMode;
  invoke: TauriInvoke;
  createInProcessHandler?: () => RuntimeHttpHandler | Promise<RuntimeHttpHandler>;
  /** @deprecated Use `createInProcessHandler`. */
  createMobileHandler?: () => RuntimeHttpHandler | Promise<RuntimeHttpHandler>;
  fetch?: typeof globalThis.fetch;
}

export interface TauriRuntimeServices {
  router: RuntimeRouter;
  client: FlowRuntimeClient;
}

/**
 * Adapts Tauri commands to the framework-neutral SidecarLauncher port.
 * The Rust command owns process creation, readiness probing, and termination.
 */
export function createTauriSidecarLauncher(
  options: TauriSidecarLauncherOptions,
): SidecarLauncher {
  const startCommand = options.startCommand ?? "runtime_sidecar_start";
  const stopCommand = options.stopCommand ?? "runtime_sidecar_stop";
  let started = false;

  return {
    async start(): Promise<SidecarDescriptor> {
      if (started) {
        throw new Error("Tauri sidecar launcher is already started");
      }
      const descriptor = await options.invoke<SidecarDescriptor>(startCommand);
      started = true;
      return descriptor;
    },

    async stop(): Promise<void> {
      if (!started) return;
      // Clear first so a failed native stop does not make future cleanup calls
      // accidentally target a replacement process.
      started = false;
      await options.invoke<void>(stopCommand);
    },
  };
}

/**
 * Application composition root. This is the only place where the platform
 * split is wired; UI and feature code receive the returned common client.
 */
export function createTauriRuntimeServices(
  options: CreateTauriRuntimeOptions,
): TauriRuntimeServices {
  const createInProcessHandler =
    options.createInProcessHandler ?? options.createMobileHandler;
  if (!createInProcessHandler && options.mode !== "desktop-power") {
    throw new Error("Portable Runtime requires createInProcessHandler");
  }
  const router = new RuntimeRouter({
    platform: options.platform,
    ...(options.mode ? { mode: options.mode } : {}),
    desktopPower: () => createNodeSidecarBackend({
      launcher: createTauriSidecarLauncher({ invoke: options.invoke }),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
    portable: () => createInProcessBackend({
      createHandler: createInProcessHandler ?? (() => {
        throw new Error("Portable Runtime handler is not configured");
      }),
    }),
  });

  return {
    router,
    client: new FlowRuntimeClient(router),
  };
}

export * from "./sqliteRuntimePersistence.js";
