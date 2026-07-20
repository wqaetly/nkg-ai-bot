import { describe, expect, it, vi } from "vitest";
import {
  FlowRuntimeClient,
  RuntimeRouter,
  RuntimeTransportError,
  type RuntimeBackend,
} from "@nkg-ai-bot/runtime-router";
import { ProviderFlowRuntimeClient } from "../src/providerFlowClient";
import { RuntimeCatalogHydrator } from "../src/runtimeCatalogHydrator";

describe("desktop runtime recovery contract", () => {
  it("does not replay the interrupted POST and restores Flows before the next user operation", async () => {
    const calls: string[] = [];
    const crashed: RuntimeBackend = {
      kind: "node-sidecar",
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      request: vi.fn(async (path) => {
        calls.push(`crashed:${path}`);
        throw new TypeError("sidecar socket closed");
      }),
    };
    const replacement: RuntimeBackend = {
      kind: "node-sidecar",
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      request: vi.fn(async (path) => {
        calls.push(`replacement:${path}`);
        if (path === "/flows/register") return Response.json({ registered: true });
        return Response.json({
          runId: "run-recovered",
          flowId: "builtin_chat",
          flowVersion: "1.0.0",
          status: "succeeded",
          output: "ok",
          error: null,
        });
      }),
    };
    const factory = vi.fn()
      .mockReturnValueOnce(crashed)
      .mockReturnValueOnce(replacement);
    const router = new RuntimeRouter({
      platform: "windows",
      mode: "desktop-power",
      desktopPower: factory,
      portable: () => { throw new Error("portable should not be created"); },
    });
    await router.start();
    const runtime = new FlowRuntimeClient(router);
    const initialCatalog = { total: 1, registered: 1, failures: [] };
    const hydrator = new RuntimeCatalogHydrator(
      router,
      async () => {
        await runtime.registerFlow({ id: "builtin_chat", version: "1.0.0" });
        return initialCatalog;
      },
      initialCatalog,
    );
    const providers = { createRunOptions: vi.fn(async (options) => options) };
    const client = new ProviderFlowRuntimeClient(
      runtime,
      providers as never,
      () => hydrator.ensureCurrent().then(() => undefined),
    );

    await expect(client.invoke("builtin_chat", "first"))
      .rejects.toBeInstanceOf(RuntimeTransportError);
    expect(crashed.request).toHaveBeenCalledOnce();

    await expect(client.invoke("builtin_chat", "second"))
      .resolves.toMatchObject({ runId: "run-recovered", output: "ok" });

    expect(factory).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      "crashed:/flows/builtin_chat/invoke",
      "replacement:/flows/register",
      "replacement:/flows/builtin_chat/invoke",
    ]);
  });
});
