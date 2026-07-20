import type {
  NodeSidecarBackendOptions,
  RuntimeBackend,
  SidecarDescriptor,
} from "./contracts.js";
import { assertLoopbackHttpUrl, assertRelativeRuntimePath } from "./path.js";

export function createNodeSidecarBackend(
  options: NodeSidecarBackendOptions,
): RuntimeBackend {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const tokenHeader = options.tokenHeader ?? "authorization";
  let descriptor: SidecarDescriptor | undefined;

  return {
    kind: "node-sidecar",

    async start(): Promise<void> {
      if (descriptor) return;
      const started = await options.launcher.start();
      try {
        const baseUrl = assertLoopbackHttpUrl(started.baseUrl);
        if (!started.token.trim()) {
          throw new Error("Node sidecar returned an empty startup token");
        }
        descriptor = {
          baseUrl: baseUrl.toString(),
          token: started.token,
        };
      } catch (cause) {
        await options.launcher.stop().catch(() => undefined);
        throw cause;
      }
    },

    async request(path: string, init: RequestInit = {}): Promise<Response> {
      if (!descriptor) throw new Error("Node sidecar backend is not started");
      const relativePath = assertRelativeRuntimePath(path);
      const headers = new Headers(init.headers);
      if (!headers.has(tokenHeader)) {
        const value = tokenHeader.toLowerCase() === "authorization"
          ? `Bearer ${descriptor.token}`
          : descriptor.token;
        headers.set(tokenHeader, value);
      }
      return fetchImpl(new URL(relativePath, descriptor.baseUrl), {
        ...init,
        headers,
      });
    },

    async stop(): Promise<void> {
      if (!descriptor) return;
      descriptor = undefined;
      await options.launcher.stop();
    },
  };
}
