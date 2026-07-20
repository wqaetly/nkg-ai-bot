import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ZIG_VERSION = "0.15.2";
const ZIG_ARCHIVE = `zig-x86_64-windows-${ZIG_VERSION}.zip`;
const ZIG_SHA256 = "3a0ed1e8799a2f8ce2a6e6290a9ff22e6906f8227865911fb7ddedc3cc14cb0c";
const SODIUM_VERSION = "1.0.22";
const SODIUM_ARCHIVE = `libsodium-${SODIUM_VERSION}-stable.tar.gz`;
const SODIUM_SHA256 = "3f7ea5cb0a90781cac9255f4b7cb108e8fbfec396317ecd6890749932500a4c7";
const ANDROID_API = 24;

const TARGETS = {
  aarch64: {
    rust: "aarch64-linux-android",
    zig: "aarch64-linux-android",
    ndk: "aarch64-linux-android",
  },
  armv7: {
    rust: "armv7-linux-androideabi",
    zig: "arm-linux-androideabi",
    ndk: "arm-linux-androideabi",
  },
  i686: {
    rust: "i686-linux-android",
    zig: "x86-linux-android",
    ndk: "i686-linux-android",
  },
  x86_64: {
    rust: "x86_64-linux-android",
    zig: "x86_64-linux-android",
    ndk: "x86_64-linux-android",
  },
};

export function androidTargetNames() {
  return Object.keys(TARGETS);
}

export async function ensureAndroidLibsodium({ cacheRoot, ndkHome, targetName }) {
  if (process.platform !== "win32") {
    throw new Error("Android libsodium precompilation is only needed on Windows hosts.");
  }
  const target = TARGETS[targetName];
  if (!target) {
    throw new Error(
      `Unsupported Android target ${targetName}. Expected one of: ${androidTargetNames().join(", ")}`,
    );
  }

  const prefix = join(cacheRoot, `libsodium-${SODIUM_VERSION}-android`, target.rust);
  const libDir = join(prefix, "lib");
  const sodiumLibrary = join(libDir, "libsodium.a");
  const hostCompatibilityLibrary = join(libDir, "liblibsodium.a");
  if (existsSync(sodiumLibrary) && existsSync(hostCompatibilityLibrary)) return libDir;

  const zig = await ensureZig(cacheRoot);
  const sourceDir = await ensureLibsodiumSource(cacheRoot);
  const libcFile = await createAndroidLibcFile(cacheRoot, ndkHome, target);
  await mkdir(prefix, { recursive: true });
  await run(
    zig,
    [
      "build",
      `-Dtarget=${target.zig}`,
      "-Doptimize=ReleaseFast",
      "-Dshared=false",
      "-Dstatic=true",
      "-Dtest=false",
      "--libc",
      libcFile,
      "--prefix",
      prefix,
      "--summary",
      "all",
    ],
    sourceDir,
  );
  if (!existsSync(sodiumLibrary)) {
    throw new Error(`Zig completed without producing ${sodiumLibrary}`);
  }
  // libsodium-sys-stable's build script is compiled for the Windows host and
  // therefore asks rustc for "libsodium" even when the target is Android.
  // Keep both conventional archive names in the target-specific cache.
  await copyFile(sodiumLibrary, hostCompatibilityLibrary);
  return libDir;
}

async function ensureZig(cacheRoot) {
  const zigDir = join(cacheRoot, `zig-x86_64-windows-${ZIG_VERSION}`);
  const zig = join(zigDir, "zig.exe");
  if (existsSync(zig)) return zig;

  const archive = join(cacheRoot, ZIG_ARCHIVE);
  await downloadVerified(
    [
      `https://fs.liujiacai.net/zigbuilds/${ZIG_ARCHIVE}?source=nkg-ai-bot`,
      `https://ziglang.org/download/${ZIG_VERSION}/${ZIG_ARCHIVE}`,
    ],
    archive,
    ZIG_SHA256,
  );
  const { default: extract } = await import("extract-zip");
  await extract(archive, { dir: cacheRoot });
  if (!existsSync(zig)) throw new Error(`Zig archive did not contain ${zig}`);
  return zig;
}

async function ensureLibsodiumSource(cacheRoot) {
  const archive = join(cacheRoot, SODIUM_ARCHIVE);
  await downloadVerified(
    [`https://download.libsodium.org/libsodium/releases/${SODIUM_ARCHIVE}`],
    archive,
    SODIUM_SHA256,
  );
  const extractionRoot = join(cacheRoot, `libsodium-${SODIUM_VERSION}-stable-source`);
  const sourceDir = join(extractionRoot, "libsodium-stable");
  if (existsSync(join(sourceDir, "build.zig"))) return sourceDir;

  // This exact versioned cache directory is owned by this build helper.
  await rm(extractionRoot, { recursive: true, force: true });
  await mkdir(extractionRoot, { recursive: true });
  await run("tar.exe", ["-xzf", archive, "-C", extractionRoot], cacheRoot);
  if (!existsSync(join(sourceDir, "build.zig"))) {
    throw new Error(`libsodium archive did not contain ${join(sourceDir, "build.zig")}`);
  }
  return sourceDir;
}

async function createAndroidLibcFile(cacheRoot, ndkHome, target) {
  const sysroot = join(ndkHome, "toolchains", "llvm", "prebuilt", "windows-x86_64", "sysroot");
  const includeDir = join(sysroot, "usr", "include");
  const sysIncludeDir = join(includeDir, target.ndk);
  const crtDir = join(sysroot, "usr", "lib", target.ndk, String(ANDROID_API));
  for (const directory of [includeDir, sysIncludeDir, crtDir]) {
    if (!existsSync(directory)) throw new Error(`Android NDK directory not found: ${directory}`);
  }
  const libcFile = join(cacheRoot, `android-${target.rust}-api${ANDROID_API}.libc`);
  await writeFile(
    libcFile,
    [
      `include_dir=${includeDir}`,
      `sys_include_dir=${sysIncludeDir}`,
      `crt_dir=${crtDir}`,
      "msvc_lib_dir=",
      "kernel32_lib_dir=",
      "gcc_dir=",
      "",
    ].join("\n"),
  );
  return libcFile;
}

async function downloadVerified(urls, destination, expectedSha256) {
  if (existsSync(destination)) {
    const existing = await readFile(destination);
    if (sha256(existing) === expectedSha256) return;
  }
  let lastError;
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const archive = Buffer.from(await response.arrayBuffer());
      const digest = sha256(archive);
      if (digest !== expectedSha256) {
        throw new Error(`checksum mismatch: expected ${expectedSha256}, received ${digest}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, archive);
      return;
    } catch (error) {
      lastError = new Error(`Failed to download ${url}: ${error.message}`, { cause: error });
    }
  }
  throw lastError;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}
