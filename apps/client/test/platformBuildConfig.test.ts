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
    expect(androidScript).toContain("writeAndroidGradleGlue");
    expect(androidScript).toContain('writeFile(join(androidDir, "tauri.settings.gradle")');
    expect(androidScript).toContain('writeFile(join(appDir, "tauri.build.gradle.kts")');
    expect(androidScript).toContain("Cargo metadata did not contain the direct tauri dependency");
    expect(androidScript).toContain("writeAndroidKotlinCodegen");
    expect(androidScript).toContain('replaceAll("{{library}}", libraryName)');
    const gradleProperties = await readFile(
      new URL("../src-tauri/gen/android/gradle.properties", import.meta.url),
      "utf8",
    );
    expect(gradleProperties).toContain("kotlin.incremental=false");
    expect(gradleProperties).toContain("kotlin.compiler.execution.strategy=in-process");
    expect(rootPackage.scripts.tauri).toMatch(/ --$/);
    expect(rootPackage.scripts["ios:init"]).toContain("ios init");
    expect(rootPackage.scripts["ios:build"]).toContain("ios build");
  });

  it("keeps desktop sidecar dependencies out of the mobile Rust graph", async () => {
    const cargoToml = await readFile(
      new URL("../src-tauri/Cargo.toml", import.meta.url),
      "utf8",
    );
    const rustEntry = (await readFile(
      new URL("../src-tauri/src/lib.rs", import.meta.url),
      "utf8",
    )).replaceAll("\r\n", "\n");
    const [commonDependencies, desktopDependencies] = cargoToml.split(
      '[target.\'cfg(not(any(target_os = "android", target_os = "ios")))\'.dependencies]',
    );

    expect(commonDependencies).not.toContain("tauri-plugin-shell");
    expect(commonDependencies).not.toMatch(/^tokio\s*=/m);
    expect(commonDependencies).not.toMatch(/^url\s*=/m);
    expect(commonDependencies).not.toMatch(/^uuid\s*=/m);
    expect(desktopDependencies).toContain('tauri-plugin-shell = "2"');
    expect(rustEntry).toContain("#[cfg(desktop)]\nmod runtime_sidecar;");
    expect(rustEntry).toContain("#[cfg(mobile)]\n    let builder");
  });

  it("routes Release artifacts to the matching local host", async () => {
    const rootPackage = JSON.parse(await readFile(
      new URL("../../../package.json", import.meta.url),
      "utf8",
    )) as { scripts: Record<string, string> };
    const releasePlan = await readFile(
      new URL("../../../scripts/local-release-plan.mjs", import.meta.url),
      "utf8",
    );

    expect(rootPackage.scripts["release:local"]).toBe("node scripts/local-release.mjs");
    expect(releasePlan).toContain('"Windows NSIS Release"');
    expect(releasePlan).toContain('"Android arm64 Release"');
    expect(releasePlan).toContain('"macOS DMG Release"');
    expect(releasePlan).toContain('"iOS App Store IPA"');
    expect(releasePlan).not.toContain("--debug");
    expect(releasePlan).not.toContain("ubuntu");
  });
});
