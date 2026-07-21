import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAndroidLibsodium } from "./android-libsodium.mjs";

const SODIUM_VERSION = "1.0.22";
const SODIUM_ARCHIVE = `libsodium-${SODIUM_VERSION}-stable-msvc.zip`;
const SODIUM_SHA256 = "d0a945a6ac8f6b60e47e1d9778b99b0beb6e0817602ef53543defbd39c108e7f";
const SODIUM_URL = `https://download.libsodium.org/libsodium/releases/${SODIUM_ARCHIVE}`;

export async function createRustEnvironment() {
  const env = { ...process.env };
  if (process.platform !== "win32") return createSourceRustEnvironment();
  prependWindowsCargoPath(env);

  const architecture = ({ x64: "x64", arm64: "ARM64", ia32: "Win32" })[process.arch];
  if (!architecture) throw new Error(`Unsupported Windows architecture: ${process.arch}`);

  const cacheRoot = join(
    process.env.LOCALAPPDATA ?? tmpdir(),
    "nkg-ai-bot-build",
    `libsodium-${SODIUM_VERSION}-msvc`,
  );
  // Rust's MSVC targets use the release CRT in both dev and release profiles.
  // Linking libsodium's Debug build would introduce LIBCMTD conflicts.
  const libraryDir = join(cacheRoot, "libsodium", architecture, "Release", "v143", "static");
  const libraryFile = join(libraryDir, "libsodium.lib");

  if (!existsSync(libraryFile)) {
    await installWindowsLibsodium(cacheRoot);
  }
  if (!existsSync(libraryFile)) {
    throw new Error(`libsodium archive did not contain ${libraryFile}`);
  }

  env.SODIUM_LIB_DIR = libraryDir;
  configureCargoBuildJobs(env);
  return env;
}

export async function createSourceRustEnvironment() {
  const env = { ...process.env };
  if (process.platform === "win32") {
    prependWindowsCargoPath(env);
  }
  const cacheRoot = join(
    process.env.LOCALAPPDATA ?? process.env.XDG_CACHE_HOME ?? tmpdir(),
    "nkg-ai-bot-build",
    "libsodium-source",
  );
  await mkdir(cacheRoot, { recursive: true });
  for (const filename of ["LATEST.tar.gz", "LATEST.tar.gz.minisig"]) {
    const destination = join(cacheRoot, filename);
    if (existsSync(destination)) continue;
    const response = await fetch(
      `https://download.libsodium.org/libsodium/releases/${filename}`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!response.ok) throw new Error(`Failed to download ${filename} (${response.status})`);
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  }
  // libsodium-sys verifies the downloaded archive with the official minisign
  // public key before compiling it for macOS, Linux, Android, or iOS.
  env.SODIUM_DIST_DIR = cacheRoot;
  configureCargoBuildJobs(env);
  return env;
}

export async function createAndroidRustEnvironment(targetName) {
  if (process.platform !== "win32") return createSourceRustEnvironment();

  const env = { ...process.env };
  prependWindowsCargoPath(env);
  const javaHome = firstExisting(
    env.JAVA_HOME,
    join(env.ProgramFiles ?? "C:\\Program Files", "Android", "Android Studio", "jbr"),
  );
  const androidHome = firstExisting(
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    join(env.LOCALAPPDATA ?? "", "Android", "Sdk"),
  );
  if (!javaHome) throw new Error("JAVA_HOME is not set and Android Studio's bundled JBR was not found.");
  if (!androidHome) throw new Error("ANDROID_HOME is not set and the default Android SDK was not found.");

  const ndkHome = firstExisting(env.NDK_HOME, env.ANDROID_NDK_HOME) ?? (await latestNdk(androidHome));
  if (!ndkHome) throw new Error(`No side-by-side Android NDK was found under ${join(androidHome, "ndk")}`);
  env.JAVA_HOME = javaHome;
  env.ANDROID_HOME = androidHome;
  env.ANDROID_SDK_ROOT = androidHome;
  env.NDK_HOME = ndkHome;
  env.ANDROID_NDK_HOME = ndkHome;

  if (targetName) {
    const cacheRoot = join(env.LOCALAPPDATA ?? tmpdir(), "nkg-ai-bot-build");
    env.SODIUM_LIB_DIR = await ensureAndroidLibsodium({ cacheRoot, ndkHome, targetName });
    delete env.SODIUM_DIST_DIR;
    configureAndroidCompiler(env, ndkHome, targetName);
  }
  configureCargoBuildJobs(env);
  return env;
}

export function resolveCargoBuildJobs(
  configured = process.env.CARGO_BUILD_JOBS,
  detected = availableParallelism(),
) {
  const override = configured?.trim();
  if (override) return override;
  return String(Math.max(1, Math.floor(detected)));
}

function configureCargoBuildJobs(env) {
  env.CARGO_BUILD_JOBS = resolveCargoBuildJobs(env.CARGO_BUILD_JOBS);
}

function prependWindowsCargoPath(env) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  env[pathKey] = `${join(process.env.USERPROFILE ?? "", ".cargo", "bin")};${env[pathKey] ?? ""}`;
}

function firstExisting(...candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

async function latestNdk(androidHome) {
  const root = join(androidHome, "ndk");
  if (!existsSync(root)) return undefined;
  const versions = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersions);
  const version = versions.at(-1);
  return version ? join(root, version) : undefined;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function configureAndroidCompiler(env, ndkHome, targetName) {
  const targets = {
    aarch64: { rust: "aarch64-linux-android", compiler: "aarch64-linux-android" },
    armv7: { rust: "armv7-linux-androideabi", compiler: "armv7a-linux-androideabi" },
    i686: { rust: "i686-linux-android", compiler: "i686-linux-android" },
    x86_64: { rust: "x86_64-linux-android", compiler: "x86_64-linux-android" },
  };
  const target = targets[targetName];
  if (!target) throw new Error(`Unsupported Android target: ${targetName}`);
  const toolchain = join(ndkHome, "toolchains", "llvm", "prebuilt", "windows-x86_64", "bin");
  const compiler = join(toolchain, `${target.compiler}24-clang.cmd`);
  const compilerCxx = join(toolchain, `${target.compiler}24-clang++.cmd`);
  const archiver = join(toolchain, "llvm-ar.exe");
  for (const file of [compiler, compilerCxx, archiver]) {
    if (!existsSync(file)) throw new Error(`Android NDK tool not found: ${file}`);
  }
  const cargoTarget = target.rust.replaceAll("-", "_").toUpperCase();
  const ccTarget = target.rust.replaceAll("-", "_");
  env.TARGET_CC = compiler;
  env.TARGET_CXX = compilerCxx;
  env[`CC_${ccTarget}`] = compiler;
  env[`CXX_${ccTarget}`] = compilerCxx;
  env[`AR_${ccTarget}`] = archiver;
  env[`CARGO_TARGET_${cargoTarget}_LINKER`] = compiler;
  env[`CARGO_TARGET_${cargoTarget}_AR`] = archiver;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  env[pathKey] = `${toolchain};${env[pathKey] ?? ""}`;
}

async function installWindowsLibsodium(cacheRoot) {
  const archivePath = join(cacheRoot, SODIUM_ARCHIVE);
  await mkdir(cacheRoot, { recursive: true });
  const response = await fetch(SODIUM_URL, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`Failed to download libsodium (${response.status})`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== SODIUM_SHA256) {
    throw new Error(`libsodium checksum mismatch: expected ${SODIUM_SHA256}, received ${digest}`);
  }
  await writeFile(archivePath, archive);
  const { default: extract } = await import("extract-zip");
  await extract(archivePath, { dir: cacheRoot });
}
