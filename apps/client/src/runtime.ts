import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppPlatform } from "@nkg-ai-bot/runtime-router";
import {
  attachTauriCapabilityBroker,
  createWorkerRuntimeBackend,
  TauriWorkerRuntimeHistory,
  createTauriReadOnlyToolHost,
  createTauriRuntimeServices,
  type TauriRuntimeServices,
} from "@nkg-ai-bot/tauri-runtime-adapter";
import { getPlatformFetch } from "./nativeFetch";
import {
  DEFAULT_HOSTED_AI_SERVICE_URL,
  HostedAiClient,
} from "./hostedAi";
import { HostedAiSession } from "./hostedAiSession";
import { HostedAiPurchaseController } from "./hostedAiPurchases";
import { StoreKitClient } from "./storeKit";
import { ProviderFlowRuntimeClient } from "./providerFlowClient";
import { providerSession } from "./providerSession";
import { syncRuntimeCatalog, type RuntimeCatalogSyncResult } from "./runtimeCatalog";
import { RuntimeCatalogHydrator } from "./runtimeCatalogHydrator";
import { MobileRuntimeLifecycle } from "./mobileRuntimeLifecycle";
import { ensureBuiltinFlows } from "./builtinFlows";
import {
  analyzeFlowCapabilities,
  capabilityAuthorizer,
  type FlowCapabilityReport,
} from "./capabilityPolicy";
import { listFlows } from "./storage/repositories";
import { getDatabase } from "./storage/database";
import { recoverInterruptedLearningJobs } from "./learningJobs";
import {
  ensureBuiltinAssistantSkills,
  recoverInterruptedAssistantRuns,
} from "./assistantSkills";
import { recoverInterruptedEvalRuns } from "./evaluationRepository";
import { migrateLegacyChatImages } from "./chatImageStore";

export interface StartedRuntimeServices {
  platform: AppPlatform;
  services: TauriRuntimeServices;
  client: ProviderFlowRuntimeClient;
  catalog: RuntimeCatalogSyncResult;
  lifecycle: MobileRuntimeLifecycle;
  capabilityReports: FlowCapabilityReport[];
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
  await migrateLegacyChatImages().catch((error: unknown) => {
    console.warn("Failed to migrate legacy inline chat images", error);
  });
  const fetchImpl = await getPlatformFetch(platform);
  if (import.meta.env.VITE_NKG_HOSTED_AI_ENABLED === "true") {
    const hostedServiceUrl = import.meta.env.VITE_NKG_HOSTED_AI_SERVICE_URL || DEFAULT_HOSTED_AI_SERVICE_URL;
    const hostedSession = new HostedAiSession(new HostedAiClient(
      hostedServiceUrl,
      fetchImpl,
    ));
    providerSession.configureHostedAi({
      session: hostedSession,
      platform,
      appVersion: await getVersion(),
      serviceUrl: hostedServiceUrl,
      ...(platform === "ios"
        ? { purchases: new HostedAiPurchaseController(new StoreKitClient(), hostedSession) }
        : {}),
    });
  }
  const services = createTauriRuntimeServices({
    platform,
    fetch: fetchImpl,
    invoke: <T>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args),
    createPortableBackend: async () => createWorkerRuntimeBackend({
      createWorker: () => new Worker(
        new URL("./runtime.worker.ts", import.meta.url),
        { type: "module", name: "nkg-portable-runtime" },
      ),
      attachCapabilities: (worker) => attachTauriCapabilityBroker(
        worker,
        createTauriReadOnlyToolHost({
          invoke: <T>(command: string, args?: Record<string, unknown>) =>
            invoke<T>(command, args),
        }),
        fetchImpl,
        ({ flowId, capability }) => capabilityAuthorizer.isAuthorized(flowId, capability),
      ),
      history: new TauriWorkerRuntimeHistory(await getDatabase()),
    }),
  });
  await services.router.start();
  await recoverInterruptedLearningJobs();
  await ensureBuiltinFlows();
  await ensureBuiltinAssistantSkills();
  await recoverInterruptedAssistantRuns();
  await recoverInterruptedEvalRuns();
  const catalog = await syncRuntimeCatalog(services.client);
  const capabilityReports = (await listFlows()).map((flow) =>
    analyzeFlowCapabilities(flow.graph, platform));
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
    capabilityReports,
  };
}
