export const LOCAL_EMBEDDING_MODEL_ID = "Xenova/bge-small-zh-v1.5";
export const LOCAL_EMBEDDING_MODEL_LABEL = "BGE Small 中文（本地 q8）";
export const LOCAL_EMBEDDING_MODEL_KEY = `local:${LOCAL_EMBEDDING_MODEL_ID}:q8:cls:query-instruction-v1`;

export type LocalEmbeddingRole = "query" | "document";

export interface LocalTextEmbedder {
  embed(
    texts: string[],
    roles: LocalEmbeddingRole[],
    signal?: AbortSignal,
  ): Promise<number[][]>;
  dispose?(): void;
}

type EmbedRequest = {
  type: "embed";
  id: number;
  texts: string[];
  roles: LocalEmbeddingRole[];
};

type EmbedResponse = {
  type: "result";
  id: number;
  vectors: number[][];
} | {
  type: "error";
  id: number;
  message: string;
};

type PendingRequest = {
  resolve(vectors: number[][]): void;
  reject(cause: unknown): void;
  cleanup(): void;
};

export class LocalEmbeddingWorkerClient implements LocalTextEmbedder {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  async embed(
    texts: string[],
    roles: LocalEmbeddingRole[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (texts.length === 0 || texts.length !== roles.length) {
      throw new Error("本地 Embedding 输入与角色数量不一致");
    }
    if (texts.some((text) => !text.trim())) throw new Error("本地 Embedding 文本不能为空");
    if (signal?.aborted) throw abortError(signal.reason);
    const worker = this.requireWorker();
    const id = this.nextId++;
    return new Promise<number[][]>((resolve, reject) => {
      const abort = () => {
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        request.cleanup();
        reject(abortError(signal?.reason));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      worker.postMessage({ type: "embed", id, texts, roles } satisfies EmbedRequest);
    });
  }

  dispose(): void {
    this.failAll(new Error("本地 Embedding Worker 已关闭"));
    this.worker?.terminate();
    this.worker = undefined;
  }

  private requireWorker(): Worker {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") throw new Error("当前 WebView 不支持本地 Embedding Worker");
    const worker = new Worker(new URL("./localEmbedding.worker.ts", import.meta.url), {
      type: "module",
      name: "nkg-local-embedding",
    });
    worker.addEventListener("message", (event: MessageEvent<EmbedResponse>) => {
      const response = event.data;
      if (!response || (response.type !== "result" && response.type !== "error")) return;
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      request.cleanup();
      if (response.type === "result") request.resolve(response.vectors);
      else request.reject(new Error(response.message));
    });
    worker.addEventListener("error", (event) => {
      this.failAll(new Error(event.message || "本地 Embedding Worker 运行失败"));
      worker.terminate();
      if (this.worker === worker) this.worker = undefined;
    });
    this.worker = worker;
    return worker;
  }

  private failAll(cause: unknown): void {
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(cause);
    }
    this.pending.clear();
  }
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException("本地 Embedding 已取消", "AbortError");
}
