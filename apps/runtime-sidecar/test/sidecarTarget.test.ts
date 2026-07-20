import { describe, expect, it } from "vitest";
import { resolveSidecarTarget } from "../scripts/sidecar-target.mjs";

describe("desktop sidecar target mapping", () => {
  it.each([
    ["win32", "x64", "x86_64-pc-windows-msvc", "node22-win-x64", "nkg-runtime-x86_64-pc-windows-msvc.exe"],
    ["darwin", "arm64", "aarch64-apple-darwin", "node22-macos-arm64", "nkg-runtime-aarch64-apple-darwin"],
    ["darwin", "x64", "x86_64-apple-darwin", "node22-macos-x64", "nkg-runtime-x86_64-apple-darwin"],
    ["linux", "x64", "x86_64-unknown-linux-gnu", "node22-linux-x64", "nkg-runtime-x86_64-unknown-linux-gnu"],
    ["linux", "arm64", "aarch64-unknown-linux-musl", "node22-linux-arm64", "nkg-runtime-aarch64-unknown-linux-musl"],
  ] as const)("maps %s/%s to a Tauri-compatible binary", (platform, arch, hostTuple, pkgTarget, outputName) => {
    expect(resolveSidecarTarget({ platform, arch, hostTuple })).toMatchObject({
      pkgTarget,
      outputName,
    });
  });

  it("rejects an architecture/target tuple mismatch", () => {
    expect(() => resolveSidecarTarget({
      platform: "darwin",
      arch: "arm64",
      hostTuple: "x86_64-apple-darwin",
    })).toThrow("mismatched sidecar build host");
  });
});
