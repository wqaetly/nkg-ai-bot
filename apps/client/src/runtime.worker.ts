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
import { createAffiliateCommerceNode } from "@nkg-ai-bot/commerce-flow";

const endpoint = globalThis as unknown as RuntimeWorkerEndpoint;
const fetchImpl = createBrokeredFetch(endpoint);

attachRuntimeWorker({
  endpoint,
  toolHost: createBrokeredAgentToolHost(endpoint),
  fetch: fetchImpl,
  nodes: [createAffiliateCommerceNode(fetchImpl)],
  capabilities: createRuntimeCapabilityManifest({
    platform: "portable",
    available: [...PORTABLE_CORE_CAPABILITIES, "filesystem.read"],
  }),
});
