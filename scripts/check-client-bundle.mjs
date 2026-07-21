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
  { label: "Worker runtime", pattern: /^runtime\.worker-/, maxBytes: 650 * 1024 },
  { label: "按需 LLM provider", pattern: /^llmProvider-/, maxBytes: 350 * 1024 },
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
