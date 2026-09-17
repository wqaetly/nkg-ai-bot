import { fileURLToPath } from "node:url";
import { env, pipeline } from "@huggingface/transformers";

const MODEL_ID = "Xenova/bge-small-zh-v1.5";
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = fileURLToPath(new URL("../apps/client/public/models/", import.meta.url));

const extractor = await pipeline("feature-extraction", MODEL_ID, {
  device: "cpu",
  dtype: "q8",
});
try {
  const output = await extractor("为这个句子生成表示以用于检索相关文章：用户喜欢什么颜色？", {
    pooling: "cls",
    normalize: true,
  });
  const vectors = output.tolist();
  const vector = vectors[0];
  if (!Array.isArray(vector) || vector.length !== 512 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("本地 BGE 模型没有返回有效的 512 维向量");
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (Math.abs(norm - 1) > 0.001) throw new Error(`本地 BGE 向量未归一化：${norm}`);
  console.log(`[local-embedding] verified ${MODEL_ID}: ${vector.length} dimensions`);
} finally {
  await extractor.dispose();
}
