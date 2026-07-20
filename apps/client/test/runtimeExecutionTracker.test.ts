import { describe, expect, it, vi } from "vitest";
import { RuntimeExecutionTracker } from "../src/runtimeExecutionTracker";

describe("RuntimeExecutionTracker", () => {
  it("cancels known runs and aborts every active execution on suspension", async () => {
    const cancel = vi.fn(async (runId: string) => {
      if (runId === "run-b") throw new Error("cancel route unavailable");
    });
    const tracker = new RuntimeExecutionTracker({ cancel } as never);
    const first = tracker.begin();
    const second = tracker.begin();
    const pending = tracker.begin();
    first.observeRun("run-a");
    second.observeRun("run-b");

    const result = await tracker.suspend();

    expect(cancel).toHaveBeenCalledTimes(2);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(pending.signal.aborted).toBe(true);
    expect(result).toEqual({
      abortedExecutions: 3,
      cancellationRequests: 2,
      cancellationFailures: [{ runId: "run-b", message: "cancel route unavailable" }],
    });
  });

  it("does not cancel a run after its terminal event was observed", async () => {
    const cancel = vi.fn(async () => undefined);
    const tracker = new RuntimeExecutionTracker({ cancel } as never);
    const execution = tracker.begin();
    execution.observeRun("done");
    execution.observeTerminal();

    const result = await tracker.suspend();

    expect(cancel).not.toHaveBeenCalled();
    expect(result.cancellationRequests).toBe(0);
    expect(execution.signal.aborted).toBe(true);
  });

  it("forwards a caller abort signal to the tracked request", () => {
    const tracker = new RuntimeExecutionTracker({ cancel: vi.fn() } as never);
    const caller = new AbortController();
    const execution = tracker.begin(caller.signal);

    caller.abort("user cancelled");

    expect(execution.signal.aborted).toBe(true);
    expect(execution.signal.reason).toBe("user cancelled");
    execution.finish();
  });
});
