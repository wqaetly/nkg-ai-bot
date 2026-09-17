import { describe, expect, it, vi } from "vitest";
import { ProviderFlowRuntimeClient } from "../src/providerFlowClient";

describe("ProviderFlowRuntimeClient", () => {
  it("enriches invoke options at the last moment", async () => {
    const runtime = {
      registerFlow: vi.fn(), invoke: vi.fn(async () => ({ runId: "r1" })), invokeNode: vi.fn(),
      stream: vi.fn(), streamNode: vi.fn(), getRun: vi.fn(), getEvents: vi.fn(), cancel: vi.fn(),
    };
    const providers = {
      createRunOptions: vi.fn(async (options) => ({
        ...options,
        envOverrides: { secrets: { LLM_API_KEY: "transient" } },
      })),
      completeRunOptions: vi.fn(async () => undefined),
    };
    const client = new ProviderFlowRuntimeClient(runtime as never, providers as never);

    await client.invoke("chat", { text: "hello" }, { traceId: "trace" });

    expect(providers.createRunOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace",
        signal: expect.any(AbortSignal),
      }),
      { flowId: "chat" },
    );
    expect(runtime.invoke).toHaveBeenCalledWith("chat", { text: "hello" }, expect.objectContaining({
      traceId: "trace",
      envOverrides: { secrets: { LLM_API_KEY: "transient" } },
      signal: expect.any(AbortSignal),
    }));
    expect(providers.completeRunOptions).toHaveBeenCalledWith(runtime.invoke.mock.calls[0]?.[2]);
  });

  it("tracks streamed run ids so suspension cancels the runtime run", async () => {
    let requestSignal: AbortSignal | undefined;
    const runtime = {
      registerFlow: vi.fn(), invoke: vi.fn(), invokeNode: vi.fn(),
      stream: vi.fn(async function* (_flowId, _input, options) {
        requestSignal = options.signal;
        yield {
          eventId: "e1", runId: "run-mobile", flowId: "chat", flowVersion: "1",
          seq: 1, timestamp: "now", kind: "run_started", payload: {},
        };
        if (options.signal?.aborted) throw options.signal.reason;
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        });
      }),
      streamNode: vi.fn(), getRun: vi.fn(), getEvents: vi.fn(),
      cancel: vi.fn(async () => undefined),
    };
    const providers = { createRunOptions: vi.fn(async (options) => options) };
    const client = new ProviderFlowRuntimeClient(runtime as never, providers as never);
    const iterator = client.stream("chat", {})[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ runId: "run-mobile" });
    const suspension = await client.suspendActiveExecutions();

    expect(runtime.cancel).toHaveBeenCalledWith("run-mobile");
    expect(requestSignal?.aborted).toBe(true);
    expect(suspension).toMatchObject({ abortedExecutions: 1, cancellationRequests: 1 });
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("prepares a recovered runtime before resolving secrets or invoking a Flow", async () => {
    const calls: string[] = [];
    const runtime = {
      registerFlow: vi.fn(),
      invoke: vi.fn(async () => {
        calls.push("invoke");
        return { runId: "r1" };
      }),
      invokeNode: vi.fn(), stream: vi.fn(), streamNode: vi.fn(),
      getRun: vi.fn(), getEvents: vi.fn(), cancel: vi.fn(),
    };
    const providers = {
      createRunOptions: vi.fn(async (options) => {
        calls.push("secrets");
        return options;
      }),
    };
    const prepare = vi.fn(async () => { calls.push("catalog"); });
    const client = new ProviderFlowRuntimeClient(
      runtime as never,
      providers as never,
      prepare,
    );

    await client.invoke("chat", {});

    expect(calls).toEqual(["catalog", "secrets", "invoke"]);
  });

  it("prefers an explicit suspension AbortError over a racing stream transport failure", async () => {
    let releaseFailure: (() => void) | undefined;
    let runStarted = false;
    const runtime = {
      registerFlow: vi.fn(), invoke: vi.fn(), invokeNode: vi.fn(),
      stream: vi.fn(async function* (_flowId, _input, options) {
        options.onRunStarted?.("run-race");
        runStarted = true;
        await new Promise<void>((resolve) => { releaseFailure = resolve; });
        throw new TypeError("native stream disconnected first");
      }),
      streamNode: vi.fn(), getRun: vi.fn(), getEvents: vi.fn(),
      cancel: vi.fn(async () => { releaseFailure?.(); }),
    };
    const providers = { createRunOptions: vi.fn(async (options) => options) };
    const client = new ProviderFlowRuntimeClient(runtime as never, providers as never);
    const iterator = client.stream("chat", {})[Symbol.asyncIterator]();
    const pending = iterator.next();
    await vi.waitFor(() => expect(runStarted).toBe(true));

    const suspension = await client.suspendActiveExecutions();

    expect(suspension).toMatchObject({ abortedExecutions: 1, cancellationRequests: 1 });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
