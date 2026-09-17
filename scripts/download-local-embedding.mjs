import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_ID = "Xenova/bge-small-zh-v1.5";
const REVISION = "75c43b069aac4d136ba6bc1122f995fedcfd2781";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const destinationRoot = join(
  repositoryRoot,
  "apps",
  "client",
  "public",
  "models",
  ...MODEL_ID.split("/"),
);

const files = [
  { path: "README.md", size: 1_057, gitBlob: "e26ec7fcc01a7aff66171d44acff0a80fae865e1" },
  { path: "config.json", size: 716, gitBlob: "d590a6643f5dcdd0cfb0477e3c291488c16fc2d7" },
  {
    path: "onnx/model_quantized.onnx",
    size: 24_010_842,
    sha256: "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc",
  },
  { path: "quantize_config.json", size: 674, gitBlob: "1930f78444c1fa23c7c5dc01e60d98b19c6e2be9" },
  { path: "special_tokens_map.json", size: 125, gitBlob: "a8b3208c2884c4efb86e49300fdd3dc877220cdf" },
  { path: "tokenizer.json", size: 439_125, gitBlob: "cdb3043fc938fc918c06e66cf704c2ba58f88747" },
  { path: "tokenizer_config.json", size: 367, gitBlob: "3a59388f0fd1bd22dec2ce7902c1be8e1fb84107" },
  { path: "vocab.txt", size: 109_540, gitBlob: "ca4f9781030019ab9b253c6dcb8c7878b6dc87a5" },
];

for (const file of files) {
  const target = join(destinationRoot, ...file.path.split("/"));
  if (await isValid(target, file)) {
    console.log(`[local-embedding] verified ${file.path}`);
    continue;
  }
  await mkdir(dirname(target), { recursive: true });
  const url = `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/${file.path}?download=true`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`下载 ${file.path} 失败：HTTP ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  verify(content, file);
  const temporary = `${target}.download`;
  await rm(temporary, { force: true });
  await writeFile(temporary, content);
  await rename(temporary, target);
  console.log(`[local-embedding] downloaded ${file.path}`);
}

async function isValid(path, expected) {
  try {
    const content = await readFile(path);
    verify(content, expected);
    return true;
  } catch {
    return false;
  }
}

function verify(content, expected) {
  if (content.length !== expected.size) {
    throw new Error(`${expected.path} 大小校验失败`);
  }
  if (expected.sha256) {
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== expected.sha256) throw new Error(`${expected.path} SHA-256 校验失败`);
    return;
  }
  const digest = createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
  if (digest !== expected.gitBlob) throw new Error(`${expected.path} Git blob 校验失败`);
}
