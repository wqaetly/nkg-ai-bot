import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppPlatform } from "@nkg-ai-bot/runtime-router";
import {
  createTauriSqliteRuntimePersistence,
  createTauriPortableCapabilities,
  createTauriReadOnlyToolHost,
  createTauriRuntimeServices,
  type TauriRuntimeServices,
} from "@nkg-ai-bot/tauri-runtime-adapter";
import { getPlatformFetch } from "./nativeFetch";
import { ProviderFlowRuntimeClient } from "./providerFlowClient";
import { providerSession } from "./providerSession";
import { syncRuntimeCatalog, type RuntimeCatalogSyncResult } from "./runtimeCatalog";
import { RuntimeCatalogHydrator } from "./runtimeCatalogHydrator";
import { MobileRuntimeLifecycle } from "./mobileRuntimeLifecycle";
import { ensureBuiltinFlows } from "./builtinFlows";
import { getDatabase } from "./storage/database";

export interface StartedRuntimeServices {
  platform: AppPlatform;
  services: TauriRuntimeServices;
  client: ProviderFlowRuntimeClient;
  catalog: RuntimeCatalogSyncResult;
  lifecycle: MobileRuntimeLifecycle;
}

let startup: Promise<StartedRuntimeServices> | undefined;

export function getRuntimeServices(): Promise<StartedRuntimeServices> {
  startup ??= startRuntime().catch((error: unknown) => {
    startup = undefined;
    throw error;
  });
  return startup;
}

async function startRuntime(): Promise<StartedRuntimeServices> {
  const platform = await invoke<AppPlatform>("runtime_platform");
  const fetchImpl = await getPlatformFetch(platform);
  const services = createTauriRuntimeServices({
    platform,
    fetch: fetchImpl,
    invoke: <T>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args),
    createInProcessHandler: async () => {
      const { createPortableHttpRuntime } = await import("@ai-native-flow/transport-http/portable");
      const persistence = await createTauriSqliteRuntimePersistence(await getDatabase());
      return (await createPortableHttpRuntime({
        runStore: persistence.runStore,
        registryStore: persistence.registryStore,
        artifactStore: persistence.artifactStore,
        eventBus: persistence.eventBus,
        variables: persistence.variables,
        capabilities: createTauriPortableCapabilities(platform),
        toolHost: createTauriReadOnlyToolHost({
          invoke: <T>(command: string, args?: Record<string, unknown>) =>
            invoke<T>(command, args),
        }),
        fetch: fetchImpl,
      })).handler;
    },
  });
  await services.router.start();
  await ensureBuiltinFlows();
  const catalog = await syncRuntimeCatalog(services.client);
  const catalogHydrator = new RuntimeCatalogHydrator(
    services.router,
    () => syncRuntimeCatalog(services.client),
    catalog,
  );
  const client = new ProviderFlowRuntimeClient(
    services.client,
    providerSession,
    () => catalogHydrator.ensureCurrent().then(() => undefined),
  );
  const appWindow = getCurrentWindow();
  const lifecycle = new MobileRuntimeLifecycle({
    platform,
    initialCatalog: catalog,
    listen: (event, handler) => appWindow.listen(event, handler),
    suspendExecutions: () => client.suspendActiveExecutions(),
    resumeRuntime: async () => {
      return catalogHydrator.refresh();
    },
  });
  await lifecycle.start();
  if (platform === "android" || platform === "ios") {
    lifecycle.subscribe((state) => {
      console.info(`[runtime:lifecycle] ${state.phase}`);
    });
  }
  return {
    platform,
    services,
    catalog,
    client,
    lifecycle,
  };
}
