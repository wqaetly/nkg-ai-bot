import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalReleasePlan,
  formatCommand,
  parseLocalReleaseOptions,
} from "./local-release-plan.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspace = dirname(scriptDir);
const tauriDir = join(workspace, "apps", "client", "src-tauri");
const options = parseLocalReleaseOptions(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const plan = createLocalReleasePlan(process.platform, options);
printPlan(plan);
if (options.dryRun) process.exit(0);

await verifyHost(plan.platform);
await ensureSubmodule();
await ensureDependencies(options);

const startedAt = new Date();
for (const [index, releaseStep] of plan.steps.entries()) {
  process.stdout.write(`\n[${index + 1}/${plan.steps.length}] ${releaseStep.label}\n`);
  if (releaseStep.kind === "ios-init") await ensureIosProject();
  else await run(releaseStep.command, releaseStep.args);
}

const output = await collectArtifacts(plan, startedAt);
process.stdout.write(`\nRelease 构建完成：${output}\n`);

async function verifyHost(platform) {
  const required = platform === "darwin"
    ? ["git", "npm", "rustup", "cargo", "xcodebuild", "xcrun"]
    : ["git", "npm", "rustup", "cargo"];
  for (const command of required) {
    await run(command, [command === "git" ? "--version" : "--version"], { quiet: true });
  }
}

async function ensureSubmodule() {
  const packageFile = join(workspace, "nkg-ai-flow", "package.json");
  if (!existsSync(packageFile)) {
    await run("git", ["submodule", "update", "--init", "--recursive"]);
  }
  const statusText = await capture("git", ["submodule", "status", "--recursive"]);
  const mismatched = statusText.split(/\r?\n/).filter((line) => line.startsWith("+") || line.startsWith("-"));
  if (mismatched.length > 0) {
    throw new Error(`submodule 未对齐当前提交：\n${mismatched.join("\n")}`);
  }
}

async function ensureDependencies(buildOptions) {
  if (buildOptions.skipInstall) return;
  const lockPath = join(workspace, "package-lock.json");
  const markerPath = join(workspace, "node_modules", ".nkg-ai-bot-lock.sha256");
  const lockHash = createHash("sha256").update(await readFile(lockPath)).digest("hex");
  const marker = existsSync(markerPath) ? (await readFile(markerPath, "utf8")).trim() : "";
  if (!buildOptions.forceInstall && marker === lockHash) {
    process.stdout.write("依赖与 package-lock.json 一致，复用 node_modules。\n");
    return;
  }
  await run("npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund"]);
  await writeFile(markerPath, `${lockHash}\n`);
}

async function ensureIosProject() {
  const appleRoot = join(tauriDir, "gen", "apple");
  const entries = existsSync(appleRoot) ? await readdir(appleRoot) : [];
  if (entries.some((entry) => entry.endsWith(".xcodeproj") || entry.endsWith(".xcworkspace"))) {
    process.stdout.write("iOS 工程已存在，跳过 init。\n");
    return;
  }
  await run("npm", ["run", "ios:init", "--", "--ci"]);
}

async function collectArtifacts(releasePlan, buildStartedAt) {
  const config = JSON.parse(await readFile(join(tauriDir, "tauri.conf.json"), "utf8"));
  const version = String(config.version ?? "0.0.0");
  const timestamp = buildStartedAt.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const outputDir = join(workspace, "artifacts", "releases", version, `${releasePlan.platform}-${timestamp}`);
  await mkdir(outputDir, { recursive: true });

  const sourceFiles = [];
  if (releasePlan.platform === "win32") {
    sourceFiles.push(await latestFile(
      join(tauriDir, "target", "release", "bundle", "nsis"),
      ".exe",
      "Windows NSIS",
    ));
  } else {
    sourceFiles.push(await latestFile(
      join(tauriDir, "target", "release", "bundle", "dmg"),
      ".dmg",
      "macOS DMG",
    ));
  }
  if (releasePlan.productKinds.includes("android-apk")) {
    const androidOutputs = join(tauriDir, "gen", "android", "app", "build", "outputs");
    const isArm64Release = (path) => {
      const normalized = path.replaceAll("\\", "/").toLowerCase();
      return normalized.includes("arm64") && normalized.includes("release");
    };
    sourceFiles.push(
      await latestFile(androidOutputs, ".apk", "Android arm64 Release APK", isArm64Release),
    );
    if (releasePlan.productKinds.includes("android-aab")) {
      sourceFiles.push(
        await latestFile(androidOutputs, ".aab", "Android arm64 Release AAB", isArm64Release),
      );
    }
  }

  if (releasePlan.productKinds.includes("ios-ipa")) {
    sourceFiles.push(await latestFile(
      join(tauriDir, "gen", "apple", "build"),
      ".ipa",
      "iOS IPA",
    ));
  }

  const expectedFileKinds = releasePlan.productKinds.length;
  if (sourceFiles.length < expectedFileKinds) {
    throw new Error(`期望至少 ${expectedFileKinds} 个发布文件，只找到 ${sourceFiles.length} 个`);
  }

  const artifacts = [];
  for (const source of unique(sourceFiles)) {
    const alreadyCollected = resolve(dirname(source)) === resolve(outputDir);
    const prefix = artifactPrefix(source);
    const target = alreadyCollected ? source : join(outputDir, `${prefix}-${basename(source)}`);
    if (!alreadyCollected) await cp(source, target, { force: true });
    const fileStat = await stat(target);
    artifacts.push({
      file: basename(target),
      bytes: fileStat.size,
      mib: Number((fileStat.size / 1024 / 1024).toFixed(2)),
      sha256: await sha256(target),
    });
  }

  const commit = (await capture("git", ["rev-parse", "HEAD"])).trim();
  const manifest = {
    schemaVersion: 1,
    appVersion: version,
    commit,
    host: { platform: process.platform, arch: process.arch },
    iosExportMethod: releasePlan.productKinds.includes("ios-ipa") ? "app-store-connect" : null,
    createdAt: new Date().toISOString(),
    artifacts,
  };
  await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const artifact of artifacts) {
    process.stdout.write(`- ${artifact.file} (${artifact.mib} MiB) ${artifact.sha256}\n`);
  }
  return outputDir;
}

async function findFiles(root, extensions) {
  if (!existsSync(root)) return [];
  const results = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) results.push(...await findFiles(path, extensions));
    else if (extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))) results.push(path);
  }
  return results;
}

async function latestFile(root, extension, label, predicate = () => true) {
  const candidates = (await findFiles(root, [extension])).filter(predicate);
  if (candidates.length === 0) throw new Error(`${label} 构建成功但没有找到 ${extension} 产物`);
  const dated = await Promise.all(candidates.map(async (path) => ({
    path,
    mtimeMs: (await stat(path)).mtimeMs,
  })));
  return dated.sort((left, right) => right.mtimeMs - left.mtimeMs)[0].path;
}

function unique(values) {
  return [...new Set(values.map((value) => resolve(value)))];
}

function artifactPrefix(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".dmg")) return "macos";
  if (lower.endsWith(".exe")) return "windows";
  if (lower.endsWith(".apk")) return "android";
  if (lower.endsWith(".aab")) return "android";
  if (lower.endsWith(".ipa")) return "ios";
  if (lower.endsWith(".zip")) return "ios";
  return "release";
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function run(command, args, runOptions = {}) {
  if (!runOptions.quiet) process.stdout.write(`$ ${formatCommand(command, args)}\n`);
  return new Promise((resolveRun, reject) => {
    const executable = resolveExecutable(command);
    const shell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
    const child = spawn(executable, args, {
      cwd: workspace,
      env: { ...process.env, CI: "true" },
      shell,
      stdio: runOptions.quiet ? "ignore" : "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

function resolveExecutable(command) {
  if (process.platform === "win32" && command === "npm") return "npm.cmd";
  if (command === "cargo" || command === "rustup") {
    const suffix = process.platform === "win32" ? ".exe" : "";
    const userInstall = join(homedir(), ".cargo", "bin", `${command}${suffix}`);
    if (existsSync(userInstall)) return userInstall;
  }
  return command;
}

function capture(command, args) {
  return new Promise((resolveCapture, reject) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveCapture(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

function printPlan(releasePlan) {
  process.stdout.write(`本地 Release 主机：${releasePlan.platform}/${process.arch}\n`);
  for (const releaseStep of releasePlan.steps) {
    const detail = releaseStep.kind === "command"
      ? formatCommand(releaseStep.command, releaseStep.args)
      : "按需初始化";
    process.stdout.write(`- ${releaseStep.label}: ${detail}\n`);
  }
}

function printHelp() {
  process.stdout.write(`用法：npm run release:local -- [选项]\n\n`);
  process.stdout.write(`  --dry-run       只显示当前系统的构建计划\n`);
  process.stdout.write(`  --android-aab    Windows 构建额外生成 Google Play AAB\n`);
  process.stdout.write(`  --install       强制按 lockfile 重装依赖\n`);
  process.stdout.write(`  --skip-install  不检查或安装依赖\n`);
  process.stdout.write(`  --skip-tests    跳过测试，仅用于已完成验收后的快速重打包\n`);
  process.stdout.write(`\nWindows 默认产出 NSIS、Android APK；AAB 需显式选择。macOS 产出 DMG、App Store Connect IPA。\n`);
}
