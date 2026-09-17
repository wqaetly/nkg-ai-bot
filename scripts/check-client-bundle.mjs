import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const assetsDir = fileURLToPath(new URL("../apps/client/dist/assets/", import.meta.url));
const files = await readdir(assetsDir);
const javascript = await Promise.all(
  files.filter((name) => name.endsWith(".js")).map(async (name) => ({
    name,
    bytes: (await stat(join(assetsDir, name))).size,
  })),
);

const budgets = [
  { label: "主线程 runtime", pattern: /^runtime-(?!worker)/, maxBytes: 150 * 1024 },
  { label: "Worker runtime", pattern: /^runtime\.worker-/, maxBytes: 5 * 1024 * 1024 },
  { label: "按需 LLM provider", pattern: /^llmProvider-/, maxBytes: 350 * 1024 },
  { label: "本地 Embedding Worker", pattern: /^localEmbedding\.worker-/, maxBytes: 600 * 1024 },
];

for (const budget of budgets) {
  const asset = javascript.find(({ name }) => budget.pattern.test(name));
  if (!asset) throw new Error(`未找到${budget.label}构建产物`);
  const actualKiB = (asset.bytes / 1024).toFixed(1);
  const limitKiB = (budget.maxBytes / 1024).toFixed(0);
  if (asset.bytes > budget.maxBytes) {
    throw new Error(`${budget.label} ${actualKiB} KiB 超过预算 ${limitKiB} KiB`);
  }
  console.log(`[bundle-budget] ${budget.label}: ${actualKiB} KiB / ${limitKiB} KiB`);
}

const binaryBudgets = [
  {
    label: "ONNX Runtime WASM",
    path: join(assetsDir, files.find((name) => name.endsWith(".wasm")) ?? "missing.wasm"),
    maxBytes: 24 * 1024 * 1024,
  },
  {
    label: "本地 BGE q8 模型",
    path: join(
      assetsDir,
      "..",
      "models",
      "Xenova",
      "bge-small-zh-v1.5",
      "onnx",
      "model_quantized.onnx",
    ),
    maxBytes: 24 * 1024 * 1024,
  },
];

for (const budget of binaryBudgets) {
  const bytes = (await stat(budget.path)).size;
  const actualMiB = (bytes / 1024 / 1024).toFixed(2);
  const limitMiB = (budget.maxBytes / 1024 / 1024).toFixed(0);
  if (bytes > budget.maxBytes) {
    throw new Error(`${budget.label} ${actualMiB} MiB 超过预算 ${limitMiB} MiB`);
  }
  console.log(`[bundle-budget] ${budget.label}: ${actualMiB} MiB / ${limitMiB} MiB`);
}
