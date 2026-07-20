import { describe, expect, it, vi } from "vitest";
import { defineFlow } from "../../../nkg-ai-flow/packages/flow-builder/src/index.js";
import { createBrowserRuntime } from "../../../nkg-ai-flow/packages/runtime/src/browser.js";
import {
  createTauriRuntimeServices,
  type TauriInvoke,
} from "../../../packages/tauri-runtime-adapter/src/index.js";
import { createNkgMobileRuntime } from "../../../packages/tauri-runtime-adapter/src/nkgMobileRuntime.js";
import { ProviderFlowRuntimeClient } from "../src/providerFlowClient";

describe("mobile runtime suspension contract", () => {
  it.each(["android", "ios"] as const)(
    "cancels a real in-process nkg-ai-flow run when the %s app is suspended",
    async (platform) => {
      const definitionRuntime = createBrowserRuntime();
      const flow = defineFlow({
        id: "mobile_suspend_contract",
        version: "1.0.0",
        registry: definitionRuntime.nodeTypeRegistry,
      });
      const start = flow.node("start", { id: "start", position: { x: 0, y: 0 } });
      const delay = flow.node("delay", {
        id: "delay",
        position: { x: 120, y: 0 },
        config: { durationMs: 60_000 },
      });
      const end = flow.node("end", { id: "end", position: { x: 240, y: 0 } });
      flow.connect(start.out("out"), delay.in("in"));
      flow.connect(delay.out("out"), end.in("in"));
      const graph = JSON.parse(flow.dump());

      const mobileRuntime = await createNkgMobileRuntime({ flows: [graph] });
      const services = createTauriRuntimeServices({
        platform,
        invoke: vi.fn() as TauriInvoke,
        createMobileHandler: () => mobileRuntime.handler,
      });
      const client = new ProviderFlowRuntimeClient(
        services.client,
        { createRunOptions: async (options) => options } as never,
      );

      try {
        let runId: string | undefined;
        const iterator = client.stream("mobile_suspend_contract", {}, {
          onRunStarted: (id) => { runId = id; },
        })[Symbol.asyncIterator]();
        const firstEvent = iterator.next();
        await vi.waitFor(() => expect(runId).toBeTypeOf("string"));

        const suspension = await client.suspendActiveExecutions();
        expect(suspension).toMatchObject({
          abortedExecutions: 1,
          cancellationRequests: 1,
          cancellationFailures: [],
        });

        const record = await waitForCancelled(services.client, runId!);
        expect(record.status).toBe("cancelled");
        void firstEvent.catch(() => undefined);
        await iterator.return?.();
      } finally {
        await services.router.stop();
      }
    },
  );
});

async function waitForCancelled(
  client: { getRun(runId: string): Promise<{ status: string; [key: string]: unknown }> },
  runId: string,
): Promise<{ status: string; [key: string]: unknown }> {
  let lastRecord: { status: string; [key: string]: unknown } | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const record = await client.getRun(runId);
    lastRecord = record;
    if (record.status === "cancelled") return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${runId} did not become cancelled: ${JSON.stringify(lastRecord)}`);
}
