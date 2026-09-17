import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import extractZip from "extract-zip";

const tauriDir = fileURLToPath(new URL("../apps/client/src-tauri/", import.meta.url));
const nativeDir = join(tauriDir, "native", "zvec");
const version = "0.7.0";
// Pinned upstream release assets; no source builds or downloads during Cargo compilation.
const assets = {
  "windows-amd64": ["zip", "549f0893a376c8e5b4cf1e685ef55ca37f41a39f5e016632ac1f762ad703d551"],
  "linux-amd64": ["tar.gz", "db9472ef2146b8f435b45b47a644eb7a75eb84b9946334debfcfc21112cec7f9"],
  "linux-arm64": ["tar.gz", "9a2a2867fb6ddb53212029b7f50eac288ad86bebfccb6ea6d52b3f35c4e026a8"],
  "linux-musl-amd64": ["tar.gz", "8d863da76921cb46cf3799236cb83ee026cc94a76e97b1cd697129b64a89dd3d"],
  "linux-musl-arm64": ["tar.gz", "6385fe59639639fb60163649d8b1ce137e1c6f5428af57cc7d47d8d0e655d4ce"],
  "osx-arm64": ["tar.gz", "ac909c57e084bb39f7f98ef89b28db322df88348254158eedefa9c00e2c34dfc"],
  "android-arm64": ["zip", "57e0f498fde1722f284e8904fafbdefe6f3f77e4de52ed65dc913d2df7cd6b1f"],
  ios: ["zip", "366b39e52da8e9d842bffab0f509af7c6f569ac5a638524ed4a17ce0151d2a4e"],
};

export function zvecTarget(platform = process.platform, arch = process.arch, musl = false) {
  const architecture = { x64: "amd64", x86_64: "amd64", aarch64: "arm64", arm64: "arm64" }[arch];
  if (platform === "ios" && architecture !== "arm64") {
    throw new Error("The pinned iOS zvec SDK supports ARM64 devices and ARM64 simulators only");
  }
  const target = platform === "ios" ? "ios"
    : `${{ win32: "windows", darwin: "osx", linux: musl ? "linux-musl" : "linux", android: "android" }[platform]}-${architecture}`;
  if (!assets[target]) throw new Error(`No pinned zvec SDK for ${platform}/${arch}. Supply a compatible ZVEC_LIB_DIR or build a supported target.`);
  return target;
}

export async function prepareZvec(env, { platform = process.platform, arch = process.arch, simulator = false } = {}) {
  const musl = platform === "linux" && !process.report.getReport().header.glibcVersionRuntime;
  let libDir = env.NKG_ZVEC_MANAGED === "1" ? undefined : env.ZVEC_LIB_DIR;
  if (!libDir) {
    const target = zvecTarget(platform, arch, musl);
    const [extension, sha256] = assets[target];
    const sdk = join(nativeDir, `${version}-${target}`);
    const marker = join(sdk, ".verified");
    if (!existsSync(marker)) {
      await mkdir(sdk, { recursive: true });
      const name = `zvec-sdk-${target}.${extension}`;
      const archive = join(nativeDir, name);
      if (!existsSync(archive)) {
        console.log(`Downloading zvec ${version} (${target})`);
        const response = await fetch(`https://github.com/alibaba/zvec/releases/download/v${version}/${name}`, {
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) throw new Error(`zvec download failed: HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        verifyArchive(bytes, sha256);
        await writeFile(archive, bytes);
      }
      verifyArchive(await readFile(archive), sha256);
      if (extension === "zip") await extractZip(archive, { dir: sdk });
      else execFileSync("tar", ["-xzf", archive, "-C", sdk], { stdio: "inherit", windowsHide: true });
      await writeFile(marker, sha256);
    }
    const nestedArchive = join(sdk, `zvec-sdk-${target}.tar.gz`);
    if (existsSync(nestedArchive) && !existsSync(join(sdk, "lib"))) {
      execFileSync("tar", ["-xzf", nestedArchive, "-C", sdk], { stdio: "inherit", windowsHide: true });
    }
    if (platform === "ios") {
      libDir = await prepareIos(sdk, simulator);
    } else {
      libDir = join(sdk, "lib");
      // Android's zip release has an enclosing directory on some releases.
      if (!existsSync(libDir)) {
        const entries = await readdir(sdk, { withFileTypes: true });
        const enclosing = entries.find((entry) => entry.isDirectory() && existsSync(join(sdk, entry.name, "lib")));
        if (enclosing) libDir = join(sdk, enclosing.name, "lib");
      }
    }
  }
  if (!env.ZVEC_LIB_DIR || env.NKG_ZVEC_MANAGED === "1") env.NKG_ZVEC_MANAGED = "1";
  env.ZVEC_LIB_DIR = resolve(libDir);
  env.ZVEC_AUTO_BUILD = "0";
  if (platform !== "ios") {
    const filename = platform === "win32" ? "zvec_c_api.dll"
      : platform === "darwin" ? "libzvec_c_api.dylib" : "libzvec_c_api.so";
    if (!existsSync(join(libDir, filename))) throw new Error(`Missing zvec library: ${join(libDir, filename)}`);
    const destination = platform === "android"
      ? join(tauriDir, "gen", "android", "app", "src", "main", "jniLibs", {
        aarch64: "arm64-v8a", arm64: "arm64-v8a", armv7: "armeabi-v7a", i686: "x86", x86_64: "x86_64",
      }[arch] ?? arch)
      : join(nativeDir, "runtime");
    await mkdir(destination, { recursive: true });
    await copyFile(join(libDir, filename), join(destination, filename));
  }
  return env;
}

export function verifyArchive(bytes, expected) {
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new Error("zvec SDK SHA-256 mismatch; remove the cached archive and retry");
  }
}

async function prepareIos(sdk, simulator) {
  if (process.platform !== "darwin") throw new Error("iOS zvec framework preparation requires macOS/Xcode");
  const output = join(nativeDir, "zvec_c_api.xcframework");
  const frameworks = [];
  for (const slice of ["ios-arm64", "ios-arm64-simulator"]) {
    const framework = join(sdk, "frameworks", slice, "zvec_c_api.framework");
    const binary = join(framework, "zvec_c_api");
    frameworks.push(framework);
    if (!existsSync(binary)) {
      await mkdir(framework, { recursive: true });
      await copyFile(join(sdk, "libzvec_c_api.xcframework", slice, "libzvec_c_api.dylib"), binary);
      execFileSync("xcrun", ["install_name_tool", "-id", "@rpath/zvec_c_api.framework/zvec_c_api", binary]);
      await writeFile(join(framework, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.nkg.zvec</string>
<key>CFBundleExecutable</key><string>zvec_c_api</string>
<key>CFBundleName</key><string>zvec_c_api</string>
<key>CFBundlePackageType</key><string>FMWK</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>1</string>
<key>MinimumOSVersion</key><string>15.0</string>
</dict></plist>`);
    }
  }
  if (!existsSync(output)) {
    execFileSync("xcodebuild", ["-create-xcframework", ...frameworks.flatMap((path) => ["-framework", path]), "-output", output], { stdio: "inherit" });
  }
  const selected = simulator ? 1 : 0;
  const libDir = join(dirname(frameworks[selected]), "lib");
  await mkdir(libDir, { recursive: true });
  // The Rust SDK links -lzvec_c_api; its install name points into the signed framework.
  await copyFile(join(frameworks[selected], "zvec_c_api"), join(libDir, "libzvec_c_api.dylib"));
  return libDir;
}
