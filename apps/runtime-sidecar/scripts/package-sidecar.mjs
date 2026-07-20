import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectSidecarTarget } from "./sidecar-target.mjs";

const require = createRequire(import.meta.url);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = resolve(packageDir, "..", "..");
const target = detectSidecarTarget();
const output = resolve(
  workspaceDir,
  "apps",
  "client",
  "src-tauri",
  "binaries",
  target.outputName,
);

mkdirSync(dirname(output), { recursive: true });
const pkgCli = require.resolve("@yao-pkg/pkg/lib-es5/bin.js");
execFileSync(process.execPath, [
  pkgCli,
  resolve(packageDir, "dist", "runtime-sidecar.mjs"),
  "--targets",
  target.pkgTarget,
  "--output",
  output,
  "--compress",
  "GZip",
], { stdio: "inherit" });
if (process.platform !== "win32") chmodSync(output, 0o755);

process.stdout.write(`Sidecar packaged: ${output}\n`);
