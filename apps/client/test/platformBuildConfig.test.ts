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

  it("builds Android and iOS on compatible CI hosts without packaging the sidecar", async () => {
    const workflow = await readFile(
      new URL("../../../.github/workflows/mobile-build.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain("name: Android arm64 Release APK and AAB");
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).toContain("npm run android:build -- --target aarch64 --apk --aab --max-apk-mib 40");
    expect(workflow).toContain("CARGO_BUILD_JOBS: 4");
    expect(workflow).toContain("actions/cache@v4");
    expect(workflow).toContain("apps/client/src-tauri/target");
    expect(workflow).toContain("apps/client/src-tauri/Cargo.toml");
    expect(workflow).toContain("apps/client/src-tauri/gen/android/app/build.gradle.kts");
    expect(workflow).toContain("name: iOS arm64 Simulator Release app");
    expect(workflow).toContain("runs-on: macos-15");
    expect(workflow).toContain("npm run ios:init -- --ci");
    expect(workflow).toContain("npm run ios:build -- --target aarch64-sim --ci");
    expect(workflow).not.toContain("ios:build -- --debug");
    expect(workflow).not.toContain("npm run build:sidecar");
    expect(workflow).not.toContain("nkg-runtime-*");
  });

  it("builds complete desktop Release bundles on all three host systems", async () => {
    const workflow = await readFile(
      new URL("../../../.github/workflows/desktop-sidecar.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain("name: Desktop Release gates");
    expect(workflow).toContain("os: windows-latest");
    expect(workflow).toContain("bundle: nsis");
    expect(workflow).toContain("os: macos-latest");
    expect(workflow).toContain("bundle: dmg");
    expect(workflow).toContain("os: ubuntu-latest");
    expect(workflow).toContain("bundle: deb");
    expect(workflow).toContain("npm run tauri -- build --bundles ${{ matrix.bundle }}");
    expect(workflow).toContain("npm run test:nkg");
    expect(workflow).toContain("npm run test:nkg:browser");
    expect(workflow).toContain("apps/client/src-tauri/target");
    expect(workflow).toContain("actions/cache@v4");
    expect(workflow).not.toContain("tauri -- build --debug");
  });
});
