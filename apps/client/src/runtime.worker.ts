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
import {
  createAffiliateCommerceNode,
  createComputerPromotionResolverNode,
  createPublicMarketSearchNode,
  createComputerRevisionNodes,
  createBrowserCommerceNode,
  createComputerProductLinksNode,
} from "@nkg-ai-bot/commerce-flow";
import { createComputerAdvisorNodes } from "@nkg-ai-bot/commerce-flow/computer-advisor";
import { createComputerAdvisorV4Nodes } from "@nkg-ai-bot/commerce-flow/computer-advisor-v4";

const endpoint = globalThis as unknown as RuntimeWorkerEndpoint;
const fetchImpl = createBrokeredFetch(endpoint);

attachRuntimeWorker({
  endpoint,
  toolHost: createBrokeredAgentToolHost(endpoint),
  fetch: fetchImpl,
  nodes: [
    createAffiliateCommerceNode(fetchImpl),
    createComputerPromotionResolverNode(fetchImpl),
    createPublicMarketSearchNode(fetchImpl),
    ...createComputerRevisionNodes(fetchImpl),
    createBrowserCommerceNode(fetchImpl),
    createComputerProductLinksNode(),
    ...createComputerAdvisorNodes(),
    ...createComputerAdvisorV4Nodes(),
  ],
  capabilities: createRuntimeCapabilityManifest({
    platform: "portable",
    available: [...PORTABLE_CORE_CAPABILITIES, "filesystem.read"],
  }),
});
