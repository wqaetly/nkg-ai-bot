import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("platform build configuration", () => {
  it.each(["android", "ios"])("keeps the %s bundle free of the desktop sidecar", async (platform) => {
    const config = JSON.parse(await readFile(
      new URL(`../src-tauri/tauri.${platform}.conf.json`, import.meta.url),
      "utf8",
    )) as { build?: { beforeBuildCommand?: string }; bundle?: { externalBin?: string[] } };

    expect(config.build?.beforeBuildCommand).toBe("npm run build:frontend");
    expect(config.bundle?.externalBin).toEqual([]);
  });

  it("keeps desktop and mobile frontend build commands separate", async () => {
    const clientPackage = JSON.parse(await readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    )) as { scripts: Record<string, string> };
    const androidScript = await readFile(
      new URL("../../../scripts/android-build.mjs", import.meta.url),
      "utf8",
    );
    const rootPackage = JSON.parse(await readFile(
      new URL("../../../package.json", import.meta.url),
      "utf8",
    )) as { scripts: Record<string, string> };

    expect(clientPackage.scripts.build).toContain("sidecar:build");
    expect(clientPackage.scripts["build:frontend"]).not.toContain("sidecar");
    expect(androidScript).toContain('["run", "build:frontend", "-w", "@nkg-ai-bot/client"]');
    expect(androidScript).not.toContain('["run", "build", "-w", "@nkg-ai-bot/client"]');
    expect(rootPackage.scripts.tauri).toMatch(/ --$/);
    expect(rootPackage.scripts["ios:init"]).toContain("ios init");
    expect(rootPackage.scripts["ios:build"]).toContain("ios build");
  });

  it("builds Android and iOS on compatible CI hosts without packaging the sidecar", async () => {
    const workflow = await readFile(
      new URL("../../../.github/workflows/mobile-build.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain("name: Android arm64 Debug APK");
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).toContain("npm run android:build -- --target aarch64 --apk");
    expect(workflow).toContain("name: iOS arm64 Simulator Debug app");
    expect(workflow).toContain("runs-on: macos-15");
    expect(workflow).toContain("npm run ios:init -- --ci");
    expect(workflow).toContain("npm run ios:build -- --debug --target aarch64-sim --ci");
    expect(workflow).not.toContain("npm run build:sidecar");
    expect(workflow).not.toContain("nkg-runtime-*");
  });
});
