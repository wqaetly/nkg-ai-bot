import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import {
  LOCAL_EMBEDDING_MODEL_ID,
  type LocalEmbeddingRole,
} from "./localEmbedding";

const QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";

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

env.useBrowserCache = true;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = "/models/";

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;
let operation = Promise.resolve();

self.addEventListener("message", (event: MessageEvent<EmbedRequest>) => {
  if (event.data?.type !== "embed") return;
  operation = operation.then(() => handleRequest(event.data));
});

async function handleRequest(request: EmbedRequest): Promise<void> {
  try {
    if (request.texts.length === 0 || request.texts.length !== request.roles.length) {
      throw new Error("本地 Embedding 输入无效");
    }
    const extractor = await getExtractor();
    const inputs = request.texts.map((text, index) => (
      request.roles[index] === "query" ? `${QUERY_INSTRUCTION}${text.trim()}` : text.trim()
    ));
    const output = await extractor(inputs, { pooling: "cls", normalize: true });
    const vectors = output.tolist() as number[][];
    validateVectors(vectors, inputs.length);
    post({ type: "result", id: request.id, vectors });
  } catch (cause: unknown) {
    post({
      type: "error",
      id: request.id,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= pipeline("feature-extraction", LOCAL_EMBEDDING_MODEL_ID, {
    device: "wasm",
    dtype: "q8",
  }).catch((cause: unknown) => {
    extractorPromise = undefined;
    throw cause;
  });
  return extractorPromise;
}

function validateVectors(vectors: number[][], expected: number): void {
  if (!Array.isArray(vectors) || vectors.length !== expected) {
    throw new Error("本地 Embedding 返回的向量数量不正确");
  }
  const dimensions = vectors[0]?.length ?? 0;
  if (dimensions <= 0 || dimensions > 8_192 || vectors.some((vector) => (
    !Array.isArray(vector)
    || vector.length !== dimensions
    || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ))) {
    throw new Error("本地 Embedding 返回了无效向量");
  }
}

function post(response: EmbedResponse): void {
  self.postMessage(response);
}
