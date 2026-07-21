import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error(`Fast Windows MSI builds require win32, received ${process.platform}`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const targetDir = fileURLToPath(
  new URL("../apps/client/src-tauri/target/fast-msi", import.meta.url),
);
const startedAt = performance.now();
const child = spawn(npm, [
  "run", "tauri", "-w", "@nkg-ai-bot/client", "--", "build", "--bundles", "msi",
], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    CARGO_PROFILE_RELEASE_LTO: "false",
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
    CARGO_PROFILE_RELEASE_INCREMENTAL: "true",
    CARGO_TARGET_DIR: targetDir,
  },
  shell: process.platform === "win32",
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(3);
  process.stdout.write(`[fast-msi] elapsed=${seconds}s\n`);
  process.exitCode = code ?? (signal ? 1 : 0);
});
