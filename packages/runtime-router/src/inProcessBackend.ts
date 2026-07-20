import type {
  InProcessBackendOptions,
  RuntimeBackend,
  RuntimeHttpHandler,
} from "./contracts.js";
import { assertRelativeRuntimePath } from "./path.js";

export function createInProcessBackend(
  options: InProcessBackendOptions,
): RuntimeBackend {
  const origin = normaliseOrigin(options.origin ?? "http://runtime.local");
  let handler: RuntimeHttpHandler | undefined;

  return {
    kind: "in-process",

    async start(): Promise<void> {
      if (handler) return;
      handler = await options.createHandler();
    },

    async request(path: string, init: RequestInit = {}): Promise<Response> {
      if (!handler) throw new Error("In-process backend is not started");
      const relativePath = assertRelativeRuntimePath(path);
      return handler(new Request(new URL(relativePath, origin), init));
    },

    async stop(): Promise<void> {
      handler = undefined;
    },
  };
}

function normaliseOrigin(rawOrigin: string): URL {
  const url = new URL(rawOrigin);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("In-process origin must not contain a path, query, or hash");
  }
  return url;
}
