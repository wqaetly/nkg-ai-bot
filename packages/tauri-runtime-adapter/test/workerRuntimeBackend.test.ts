import { describe, expect, it, vi } from "vitest";
import { defineFlow } from "@ai-native-flow/flow-builder";
import { createPortableRuntime } from "@ai-native-flow/runtime";
import {
  attachRuntimeWorker,
  type RuntimeWorkerEndpoint,
} from "@ai-native-flow/runtime/worker";
import {
  attachTauriCapabilityBroker,
  createBrokeredAgentToolHost,
  createBrokeredFetch,
  createWorkerRuntimeBackend,
  type WorkerRuntimeEndpoint,
} from "../src/index.js";

describe("Worker Runtime adapter", () => {
  it("bridges Worker tool requests through the policy host", async () => {
    const { client, host } = linkedEndpoints();
    const detach = attachTauriCapabilityBroker(client, {
      async callTool(call, env) {
        return { ok: true, output: { tool: call.tool, workingDir: env.workingDir } };
      },
    });
    const toolHost = createBrokeredAgentToolHost(host);
    const result = await toolHost.callTool(
      { tool: "read_file", args: { path: "fixture.txt" } },
      {
        workingDir: "app-data",
        allowedTools: ["read_file"],
        allowBash: false,
        timeoutMs: 1_000,
        maxOutputChars: 1_000,
      },
    );
    expect(result).toEqual({
      ok: true,
      output: { tool: "read_file", workingDir: "app-data" },
    });
    detach();
  });

  it("bridges Worker HTTP through the host fetch implementation", async () => {
    const { client, host } = linkedEndpoints();
    const requests: string[] = [];
    const detach = attachTauriCapabilityBroker(
      client,
      { async callTool() { return { ok: false }; } },
      async (input) => {
        requests.push(String(input));
        return new Response("native-response", { status: 201, headers: { "x-native": "yes" } });
      },
    );
    const response = await createBrokeredFetch(host)("https://provider.invalid/v1/chat", {
      method: "POST",
      body: "fixture",
    });
    expect(requests).toEqual(["https://provider.invalid/v1/chat"]);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-native")).toBe("yes");
    expect(await response.text()).toBe("native-response");
    detach();
  });

  it("denies native tools when the Flow-scoped authorization is absent", async () => {
    const { client, host } = linkedEndpoints();
    const nativeCall = vi.fn();
    const detach = attachTauriCapabilityBroker(
      client,
      { async callTool(...args) { nativeCall(...args); return { ok: true }; } },
      globalThis.fetch,
      ({ flowId, capability }) => flowId === "approved" && capability === "filesystem.read",
    );
    const result = await createBrokeredAgentToolHost(host).callTool(
      { tool: "read_file", args: { path: "fixture.txt" } },
      {
        workingDir: "app-data",
        allowedTools: ["read_file"],
        allowBash: false,
        timeoutMs: 1_000,
        maxOutputChars: 1_000,
        runtime: {
          flowId: "denied",
          flowVersion: "1.0.0",
          runId: "run-1",
          nodeId: "reader",
        },
      },
    );
    expect(result).toMatchObject({
      ok: false,
      output: { code: "runtime.capability_not_authorized", capability: "filesystem.read" },
    });
    expect(nativeCall).not.toHaveBeenCalled();
    detach();
  });

  it("serves the existing HTTP client contract from a real Worker protocol host", async () => {
    const runtime = createPortableRuntime({ generateRunId: () => "worker_backend_run" });
    const flow = defineFlow({
      id: "worker_backend",
      version: "1.0.0",
      registry: runtime.nodeTypeRegistry,
    });
    const input = flow.node("text_input", {
      id: "input",
      position: { x: 0, y: 0 },
      config: { value: "worker output" },
    });
    const end = flow.node("end", { id: "end", position: { x: 200, y: 0 } });
    flow.connect(input.out("out"), end.in("in"));
    const { client, host } = linkedEndpoints();
    const attached = attachRuntimeWorker({ endpoint: host, runtime });
    const backend = createWorkerRuntimeBackend({
      createWorker: () => client,
    });
    await backend.start();
    const registered = await backend.request("/flows/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ graph: JSON.parse(flow.dump()) }),
    });
    expect(registered.status).toBe(204);
    const invoked = await backend.request("/flows/worker_backend/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: null }),
    });
    expect(await invoked.json()).toMatchObject({
      runId: "worker_backend_run",
      status: "succeeded",
      output: "worker output",
    });
    await backend.stop();
    attached.dispose();
  });
});

function linkedEndpoints(): { client: WorkerRuntimeEndpoint; host: RuntimeWorkerEndpoint } {
  const clientListeners = new Set<(event: { data: unknown }) => void>();
  const hostListeners = new Set<(event: { data: unknown }) => void>();
  const make = (
    own: Set<(event: { data: unknown }) => void>,
    peer: Set<(event: { data: unknown }) => void>,
  ) => ({
    postMessage(message: unknown) {
      queueMicrotask(() => {
        for (const listener of peer) listener({ data: structuredClone(message) });
      });
    },
    addEventListener(_type: "message", listener: (event: { data: unknown }) => void) {
      own.add(listener);
    },
    removeEventListener(_type: "message", listener: (event: { data: unknown }) => void) {
      own.delete(listener);
    },
  });
  return {
    client: { ...make(clientListeners, hostListeners), terminate() {} },
    host: make(hostListeners, clientListeners),
  };
}
