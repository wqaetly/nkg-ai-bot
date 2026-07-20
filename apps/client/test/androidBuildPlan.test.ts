import { describe, expect, it } from "vitest";
import {
  DEFAULT_RELEASE_MAX_APK_MIB,
  assertApkSize,
  createAndroidArtifactPlans,
  parseAndroidBuildOptions,
  selectExistingArtifact,
} from "../../../scripts/android-build-plan.mjs";

describe("Android build plan", () => {
  it("builds a release APK by default", () => {
    expect(parseAndroidBuildOptions([])).toEqual({
      profile: "release",
      buildApk: true,
      buildAab: false,
      maxApkMiB: DEFAULT_RELEASE_MAX_APK_MIB,
    });
  });

  it("requires an explicit flag for debug builds", () => {
    expect(parseAndroidBuildOptions(["--debug", "--apk"])).toEqual({
      profile: "debug",
      buildApk: true,
      buildAab: false,
      maxApkMiB: undefined,
    });
    expect(() => parseAndroidBuildOptions(["--debug", "--release"]))
      .toThrow("cannot be used together");
  });

  it("can build APK and AAB together with a custom APK budget", () => {
    expect(parseAndroidBuildOptions(["--apk", "--aab", "--max-apk-mib=32"])).toEqual({
      profile: "release",
      buildApk: true,
      buildAab: true,
      maxApkMiB: 32,
    });
    expect(() => parseAndroidBuildOptions(["--max-apk-mib"]))
      .toThrow("requires a value");
    expect(() => parseAndroidBuildOptions(["--max-apk-mib=invalid"]))
      .toThrow("must be a positive number");
  });

  it("accepts signed or unsigned release APK output names", () => {
    const [plan] = createAndroidArtifactPlans("android", "arm64", "release", true, false);
    expect(plan?.candidates).toEqual([
      expect.stringMatching(/app-arm64-release\.apk$/),
      expect.stringMatching(/app-arm64-release-unsigned\.apk$/),
    ]);
    expect(selectExistingArtifact(plan!, (path) => path.endsWith("-unsigned.apk")))
      .toMatch(/app-arm64-release-unsigned\.apk$/);
  });

  it("rejects release APKs over the configured budget", () => {
    expect(assertApkSize(26 * 1024 * 1024, 40)).toBe(26);
    expect(() => assertApkSize(41 * 1024 * 1024, 40)).toThrow("exceeding");
  });
});
