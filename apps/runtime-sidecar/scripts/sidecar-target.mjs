import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const HOSTS = {
  win32: {
    pkgPlatform: "win",
    extensions: ".exe",
    architectures: {
      x64: /^x86_64-pc-windows-(?:msvc|gnu)$/,
      arm64: /^aarch64-pc-windows-msvc$/,
    },
  },
  darwin: {
    pkgPlatform: "macos",
    extensions: "",
    architectures: {
      x64: /^x86_64-apple-darwin$/,
      arm64: /^aarch64-apple-darwin$/,
    },
  },
  linux: {
    pkgPlatform: "linux",
    extensions: "",
    architectures: {
      x64: /^x86_64-unknown-linux-(?:gnu|musl)$/,
      arm64: /^aarch64-unknown-linux-(?:gnu|musl)$/,
    },
  },
};

export function resolveSidecarTarget({ platform, arch, hostTuple }) {
  const host = HOSTS[platform];
  const tuplePattern = host?.architectures[arch];
  if (!host || !tuplePattern || !tuplePattern.test(hostTuple)) {
    throw new Error(`Unsupported or mismatched sidecar build host: ${platform}/${arch}/${hostTuple}`);
  }
  return {
    hostTuple,
    pkgTarget: `node22-${host.pkgPlatform}-${arch}`,
    extension: host.extensions,
    outputName: `nkg-runtime-${hostTuple}${host.extensions}`,
  };
}

export function detectSidecarTarget({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  const rustc = platform === "win32"
    ? resolve(env.USERPROFILE ?? "", ".cargo", "bin", "rustc.exe")
    : "rustc";
  const hostTuple = execFileSync(rustc, ["--print", "host-tuple"], { encoding: "utf8" }).trim();
  return resolveSidecarTarget({ platform, arch, hostTuple });
}
