import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalEmbeddingWorkerClient } from "../src/localEmbedding";

class FakeWorker {
  static instance: FakeWorker | undefined;
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  terminated = false;

  constructor(_url: URL, _options: WorkerOptions) {
    FakeWorker.instance = this;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message: { id: number }) {
    queueMicrotask(() => this.emit("message", {
      data: { type: "result", id: message.id, vectors: [[0.5, 0.5]] },
    } as MessageEvent));
  }

  terminate() { this.terminated = true; }

  emit(type: string, event: MessageEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instance = undefined;
});

describe("local embedding worker client", () => {
  it("runs embedding work through a dedicated module worker", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = new LocalEmbeddingWorkerClient();

    await expect(client.embed(["用户喜欢蓝色"], ["document"]))
      .resolves.toEqual([[0.5, 0.5]]);

    expect(FakeWorker.instance).toBeDefined();
    client.dispose();
    expect(FakeWorker.instance?.terminated).toBe(true);
  });

  it("rejects immediately when the caller has already cancelled", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const controller = new AbortController();
    controller.abort();

    await expect(new LocalEmbeddingWorkerClient().embed(
      ["query"],
      ["query"],
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.instance).toBeUndefined();
  });
});
