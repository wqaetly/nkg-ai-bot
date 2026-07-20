import { describe, expect, it, vi } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import {
  InMemoryArtifactStore,
  createRuntime,
  type LlmProvider,
} from "@ai-native-flow/runtime";
import {
  createBrowserRuntime,
} from "@ai-native-flow/runtime/browser";
import {
  createHttpHandler,
} from "@ai-native-flow/transport-http";
import {
  createTauriRuntimeServices,
  type TauriInvoke,
} from "../src/index.js";
import { createNkgPortableRuntime } from "../src/nkgPortableRuntime.js";

describe("desktop/mobile Runtime routing contract", () => {
  it("executes the same Flow through sidecar and in-process routes", async () => {
    const provider: LlmProvider = {
      async complete(request) {
        return { text: `route:${request.prompt}` };
      },
    };
    const definitionRuntime = createBrowserRuntime({ llmProvider: provider });
    const flow = defineFlow({
      id: "route_contract",
      version: "1.0.0",
      registry: definitionRuntime.nodeTypeRegistry,
    });
    const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
    const llm = flow.node("llm", {
      id: "llm",
      position: { x: 120, y: 0 },
      config: {
        prompt: "hello ${input.name}",
        baseUrl: "https://example.invalid/v1",
        apiKey: "user-key",
        model: "user-model",
      },
    });
    const end = flow.node("end", { id: "end", position: { x: 240, y: 0 } });
    flow.connect(start.out("out"), llm.in("in"));
    flow.connect(llm.out("out"), end.in("in"));
    const graph = JSON.parse(flow.dump());

    const desktopRuntime = createRuntime({
      llmProvider: provider,
      artifactStore: new InMemoryArtifactStore(),
    });
    await desktopRuntime.registry.register({ graph, json: JSON.stringify(graph) });
    await desktopRuntime.registry.promote(graph.id, graph.version);
    const desktopHandler = createHttpHandler({
      runtime: desktopRuntime,
      authorize: (request) =>
        request.headers.get("authorization") === "Bearer contract-token",
    });
    const invokeMock = vi.fn(async (command: string) => {
      if (command === "runtime_sidecar_start") {
        return { baseUrl: "http://127.0.0.1:43210", token: "contract-token" };
      }
      return undefined;
    });
    const desktop = createTauriRuntimeServices({
      platform: "windows",
      mode: "desktop-power",
      invoke: invokeMock as unknown as TauriInvoke,
      fetch: (input, init) => desktopHandler(new Request(input, init)),
      createInProcessHandler: () => { throw new Error("portable backend selected in desktop-power mode"); },
    });

    const mobileRuntime = await createNkgPortableRuntime({
      llmProvider: provider,
      flows: [graph],
    });
    const mobile = createTauriRuntimeServices({
      platform: "android",
      invoke: vi.fn() as TauriInvoke,
      createInProcessHandler: () => mobileRuntime.handler,
    });

    const [desktopResult, mobileResult] = await Promise.all([
      desktop.client.invoke("route_contract", { name: "desktop" }),
      mobile.client.invoke("route_contract", { name: "mobile" }),
    ]);

    expect(desktopResult.output).toBe("route:hello desktop");
    expect(mobileResult.output).toBe("route:hello mobile");
    expect(desktop.router.snapshot.backend).toBe("node-sidecar");
    expect(mobile.router.snapshot.backend).toBe("in-process");

    await Promise.all([desktop.router.stop(), mobile.router.stop()]);
  });
});
