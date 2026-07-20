import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
await writeAndroidGradleGlue({ cargo, env });

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

async function writeAndroidGradleGlue({ cargo, env }) {
  const manifestPath = join(tauriDir, "Cargo.toml");
  const metadata = JSON.parse(await capture(
    cargo,
    [
      "metadata",
      "--format-version",
      "1",
      "--manifest-path",
      manifestPath,
      "--filter-platform",
      target.rust,
    ],
    workspace,
    env,
  ));
  const rootNode = metadata.resolve?.nodes?.find((node) => node.id === metadata.resolve.root);
  if (!rootNode) throw new Error("Cargo metadata did not contain the application dependency graph");

  const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]));
  const rootPackage = packages.get(metadata.resolve.root);
  if (!rootPackage) throw new Error("Cargo metadata did not contain the application package");
  const directPackages = rootNode.deps
    .map((dependency) => packages.get(dependency.pkg))
    .filter(Boolean);
  const tauriPackage = directPackages.find((entry) => entry.name === "tauri");
  if (!tauriPackage) throw new Error("Cargo metadata did not contain the direct tauri dependency");

  const modules = [{
    name: "tauri-android",
    path: join(dirname(tauriPackage.manifest_path), "mobile", "android"),
  }];
  for (const entry of directPackages.filter((candidate) => candidate.name.startsWith("tauri-plugin-"))) {
    const modulePath = join(dirname(entry.manifest_path), "android");
    if (existsSync(modulePath)) modules.push({ name: entry.name, path: modulePath });
  }
  for (const module of modules) {
    if (!existsSync(module.path)) throw new Error(`Android Gradle module not found: ${module.path}`);
  }

  const settings = [
    "// THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.",
    ...modules.flatMap((module) => [
      `include ':${module.name}'`,
      `project(':${module.name}').projectDir = new File(\"${escapeGradlePath(module.path)}\")`,
    ]),
    "",
  ].join("\n");
  const dependencies = [
    "// THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.",
    "val implementation by configurations",
    "dependencies {",
    ...modules.map((module) => `  implementation(project(\":${module.name}\"))`),
    "}",
    "",
  ].join("\n");

  const config = JSON.parse(await readFile(join(tauriDir, "tauri.conf.json"), "utf8"));
  const version = String(config.version ?? "0.1.0");
  const versionCode = androidVersionCode(version);
  const packageName = String(config.identifier ?? "com.nkg.ai.bot");
  const libraryTarget = rootPackage.targets.find((entry) => entry.crate_types.includes("cdylib"));
  if (!libraryTarget) throw new Error("Cargo metadata did not contain the Android cdylib target");
  const proguard = [
    "# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.",
    "",
    `-keep class ${packageName}.TauriActivity {`,
    "  public app.tauri.plugin.PluginManager getPluginManager();",
    "}",
    "",
  ].join("\n");
  const properties = [
    "# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.",
    `tauri.android.versionName=${version}`,
    `tauri.android.versionCode=${versionCode}`,
    "",
  ].join("\n");

  const appDir = join(androidDir, "app");
  await writeAndroidKotlinCodegen({
    appDir,
    libraryName: libraryTarget.name,
    metadata,
    packageName,
    tauriPackage,
  });
  await Promise.all([
    writeFile(join(androidDir, "tauri.settings.gradle"), settings),
    writeFile(join(appDir, "tauri.build.gradle.kts"), dependencies),
    writeFile(join(appDir, "proguard-tauri.pro"), proguard),
    writeFile(join(appDir, "tauri.properties"), properties),
  ]);
}

async function writeAndroidKotlinCodegen({ appDir, libraryName, metadata, packageName, tauriPackage }) {
  const wryPackage = metadata.packages.find((entry) => entry.name === "wry");
  if (!wryPackage) throw new Error("Cargo metadata did not contain wry for Android code generation");
  const tauriTemplate = join(dirname(tauriPackage.manifest_path), "mobile", "android-codegen", "TauriActivity.kt");
  const wryTemplates = join(dirname(wryPackage.manifest_path), "src", "android", "kotlin");
  const generatedDir = join(
    appDir,
    "src",
    "main",
    "java",
    ...packageName.split("."),
    "generated",
  );
  await mkdir(generatedDir, { recursive: true });

  const templates = [tauriTemplate];
  for (const entry of await readdir(wryTemplates, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith(".kt") || entry.name.endsWith(".pro"))) {
      templates.push(join(wryTemplates, entry.name));
    }
  }
  for (const template of templates) {
    const output = applyAndroidTemplate(await readFile(template, "utf8"), { libraryName, packageName });
    await writeFile(join(generatedDir, template.split(/[\\/]/).at(-1)), output);
  }
}

function applyAndroidTemplate(template, { libraryName, packageName }) {
  return template
    .replaceAll("{{package-unescaped}}", packageName)
    .replaceAll("{{package}}", packageName)
    .replaceAll("{{library}}", libraryName)
    .replaceAll("{{class-extension}}", "")
    .replaceAll("{{class-init}}", "");
}

function escapeGradlePath(path) {
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function androidVersionCode(version) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (![major, minor, patch].every(Number.isInteger)) {
    throw new Error(`Tauri version is not semantic: ${version}`);
  }
  return major * 1_000_000 + minor * 1_000 + patch;
}

function capture(command, commandArgs, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, env, stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}
