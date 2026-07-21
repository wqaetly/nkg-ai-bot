import { describe, expect, it } from "vitest";
import {
  createLocalReleasePlan,
  parseLocalReleaseOptions,
} from "../../../scripts/local-release-plan.mjs";

describe("local Release plan", () => {
  it("builds Windows NSIS and Android Release artifacts on Windows", () => {
    const plan = createLocalReleasePlan("win32", parseLocalReleaseOptions([]));
    const commands = plan.steps.filter((step) => step.kind === "command")
      .map((step) => [step.command, ...step.args].join(" "));

    expect(plan.productKinds).toEqual(["windows-nsis", "android-apk", "android-aab"]);
    expect(commands).toContain("npm run tauri -- build --bundles nsis");
    expect(commands).toContain(
      "npm run android:build -- --target aarch64 --apk --aab --max-apk-mib 40",
    );
    expect(commands.join("\n")).not.toContain("--debug");
  });

  it("builds only DMG and App Store IPA artifacts on macOS", () => {
    const plan = createLocalReleasePlan("darwin", parseLocalReleaseOptions([]));
    const commands = plan.steps.filter((step) => step.kind === "command")
      .map((step) => [step.command, ...step.args].join(" "));

    expect(plan.productKinds).toEqual(["macos-dmg", "ios-ipa"]);
    expect(commands).toContain("npm run tauri -- build --bundles dmg");
    expect(commands).toContain("npm run ios:build -- --export-method app-store-connect --ci");
    expect(commands.join("\n")).not.toContain("android");
    expect(commands.join("\n")).not.toContain("--debug");
  });

  it("can skip validation for an already verified macOS rebuild", () => {
    const options = parseLocalReleaseOptions(["--skip-tests"]);
    const plan = createLocalReleasePlan("darwin", options);
    const commands = plan.steps.filter((step) => step.kind === "command")
      .map((step) => [step.command, ...step.args].join(" "));

    expect(plan.productKinds).toEqual(["macos-dmg", "ios-ipa"]);
    expect(commands).not.toContain("npm test -- --run");
  });

  it("rejects unsupported hosts and contradictory install flags", () => {
    expect(() => createLocalReleasePlan("linux", parseLocalReleaseOptions([])))
      .toThrow("support Windows and macOS");
    expect(() => parseLocalReleaseOptions(["--install", "--skip-install"]))
      .toThrow("cannot be used together");
  });

  it("keeps npm as a logical command so the runner can select npm.cmd on Windows", () => {
    for (const platform of ["win32", "darwin"] as const) {
      const plan = createLocalReleasePlan(platform, parseLocalReleaseOptions(["--skip-tests"]));
      expect(plan.steps.filter((step) => step.kind === "command" && step.command === "npm").length)
        .toBeGreaterThan(0);
    }
  });
});
