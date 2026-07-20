import type { FlowGraph } from "@ai-native-flow/flow-ir";
import {
  createBrowserRuntime,
  type CreateBrowserRuntimeOptions,
  type Runtime,
} from "@ai-native-flow/runtime/browser";
import {
  createHttpHandler,
  type HttpHandler,
} from "@ai-native-flow/transport-http";

export interface CreateNkgPortableRuntimeOptions
  extends CreateBrowserRuntimeOptions {
  flows?: ReadonlyArray<FlowGraph | string>;
}

export interface NkgPortableRuntime {
  runtime: Runtime;
  handler: HttpHandler;
}

/**
 * Builds the platform-neutral Runtime entirely in-process. Flow graphs are
 * registered and promoted before the handler becomes visible to the router.
 */
export async function createNkgPortableRuntime(
  options: CreateNkgPortableRuntimeOptions = {},
): Promise<NkgPortableRuntime> {
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
