import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAndroidRustEnvironment } from "./rust-env.mjs";

const TARGETS = {
  aarch64: { rust: "aarch64-linux-android", abi: "arm64-v8a", flavor: "arm64", gradle: "Arm64" },
  armv7: { rust: "armv7-linux-androideabi", abi: "armeabi-v7a", flavor: "arm", gradle: "Arm" },
  i686: { rust: "i686-linux-android", abi: "x86", flavor: "x86", gradle: "X86" },
  x86_64: { rust: "x86_64-linux-android", abi: "x86_64", flavor: "x86_64", gradle: "X86_64" },
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspace = dirname(scriptDir);
const tauriDir = join(workspace, "apps", "client", "src-tauri");
const androidDir = join(tauriDir, "gen", "android");
const args = process.argv.slice(2);
const targetName = optionValue(args, "--target") ?? "aarch64";
const target = TARGETS[targetName];
if (!target) throw new Error(`Unsupported --target ${targetName}`);
const release = args.includes("--release");
const profile = release ? "release" : "debug";
const profileTitle = release ? "Release" : "Debug";
const buildApk = args.includes("--apk") || !args.includes("--aab");
const buildAab = args.includes("--aab");
if (!existsSync(join(androidDir, "gradlew.bat"))) {
  throw new Error("Android project is missing. Run `npm run android:init` first.");
}

const env = await createAndroidRustEnvironment(targetName);
// Mobile bundles use the browser-safe in-process Runtime and must neither
// build nor package the desktop Node sidecar.
await run(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", "build:frontend", "-w", "@nkg-ai-bot/client"],
  workspace,
  env,
);
const cargo = join(env.USERPROFILE ?? "", ".cargo", "bin", "cargo.exe");
await run(
  cargo,
  [
    "build",
    "--package",
    "nkg-ai-bot",
    "--manifest-path",
    join(tauriDir, "Cargo.toml"),
    "--target",
    target.rust,
    "--features",
    "tauri/custom-protocol",
    "--lib",
    ...(release ? ["--release"] : []),
  ],
  workspace,
  env,
);

const rustLibrary = join(tauriDir, "target", target.rust, profile, "libnkg_ai_bot_lib.so");
const jniDirectory = join(androidDir, "app", "src", "main", "jniLibs", target.abi);
if (!existsSync(rustLibrary)) throw new Error(`Rust build did not produce ${rustLibrary}`);
await mkdir(jniDirectory, { recursive: true });
await copyFile(rustLibrary, join(jniDirectory, "libnkg_ai_bot_lib.so"));

const gradleTasks = [];
if (buildApk) gradleTasks.push(`:app:assemble${target.gradle}${profileTitle}`);
if (buildAab) gradleTasks.push(`:app:bundle${target.gradle}${profileTitle}`);
const outputs = expectedOutputs(androidDir, target.flavor, profile, buildApk, buildAab);
// Gradle's incremental package task can append a new ZIP payload to an old
// APK after the large JNI library changes, leaving unreachable bytes at the
// front of the file. Remove only the exact generated artifacts before the
// packaging task so output size and hashes remain deterministic.
await Promise.all(outputs.map((output) => rm(output, { force: true })));
await run(
  join(androidDir, "gradlew.bat"),
  [
    ...gradleTasks,
    "-x",
    `rustBuild${target.gradle}${profileTitle}`,
    "--no-daemon",
  ],
  androidDir,
  env,
);

for (const output of outputs) {
  if (!existsSync(output)) throw new Error(`Gradle completed without producing ${output}`);
  process.stdout.write(`Android artifact: ${output}\n`);
}

function expectedOutputs(root, flavor, buildProfile, apk, aab) {
  const outputs = [];
  if (apk) {
    outputs.push(join(root, "app", "build", "outputs", "apk", flavor, buildProfile, `app-${flavor}-${buildProfile}.apk`));
  }
  if (aab) {
    outputs.push(
      join(root, "app", "build", "outputs", "bundle", `${flavor}${profileTitle}`, `app-${flavor}-${buildProfile}.aab`),
    );
  }
  return outputs;
}

function optionValue(values, option) {
  const equal = values.find((value) => value.startsWith(`${option}=`));
  if (equal) return equal.slice(option.length + 1);
  const index = values.indexOf(option);
  return index >= 0 ? values[index + 1] : undefined;
}

function run(command, commandArgs, cwd, env) {
  return new Promise((resolve, reject) => {
    const shell = process.platform === "win32" && /\.(?:bat|cmd)$/i.test(command);
    const child = spawn(command, commandArgs, { cwd, env, shell, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}
