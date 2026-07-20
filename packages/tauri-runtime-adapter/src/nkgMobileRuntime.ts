import type { FlowGraph } from "../../../nkg-ai-flow/packages/flow-ir/src/index.js";
import {
  createBrowserRuntime,
  type CreateBrowserRuntimeOptions,
  type Runtime,
} from "../../../nkg-ai-flow/packages/runtime/src/browser.js";
import {
  createHttpHandler,
  type HttpHandler,
} from "../../../nkg-ai-flow/packages/transport-http/src/index.js";

export interface CreateNkgMobileRuntimeOptions
  extends CreateBrowserRuntimeOptions {
  flows?: ReadonlyArray<FlowGraph | string>;
}

export interface NkgMobileRuntime {
  runtime: Runtime;
  handler: HttpHandler;
}

/**
 * Builds the Android/iOS Runtime entirely in-process. Flow graphs are
 * registered and promoted before the handler becomes visible to the router.
 */
export async function createNkgMobileRuntime(
  options: CreateNkgMobileRuntimeOptions = {},
): Promise<NkgMobileRuntime> {
  const { flows = [], ...runtimeOptions } = options;
  const runtime = createBrowserRuntime(runtimeOptions);

  for (const source of flows) {
    const graph = typeof source === "string"
      ? JSON.parse(source) as FlowGraph
      : source;
    const json = typeof source === "string" ? source : JSON.stringify(source);
    await runtime.registry.register({ graph, json, status: "staging" });
    await runtime.registry.promote(graph.id, graph.version);
  }

  return {
    runtime,
    handler: createHttpHandler({ runtime }),
  };
}
