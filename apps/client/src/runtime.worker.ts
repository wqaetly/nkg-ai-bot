import {
  PORTABLE_CORE_CAPABILITIES,
  createRuntimeCapabilityManifest,
} from "@ai-native-flow/runtime/capabilities";
import {
  attachRuntimeWorker,
  type RuntimeWorkerEndpoint,
} from "@ai-native-flow/runtime/worker/host";
import {
  createBrokeredAgentToolHost,
  createBrokeredFetch,
} from "@nkg-ai-bot/tauri-runtime-adapter";

const endpoint = globalThis as unknown as RuntimeWorkerEndpoint;

attachRuntimeWorker({
  endpoint,
  toolHost: createBrokeredAgentToolHost(endpoint),
  fetch: createBrokeredFetch(endpoint),
  capabilities: createRuntimeCapabilityManifest({
    platform: "portable",
    available: [...PORTABLE_CORE_CAPABILITIES, "filesystem.read"],
  }),
});
