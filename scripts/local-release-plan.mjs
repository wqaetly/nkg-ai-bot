export const SUPPORTED_RELEASE_PLATFORMS = ["win32", "darwin"];

export function parseLocalReleaseOptions(args) {
  const options = {
    dryRun: false,
    androidAab: false,
    forceInstall: false,
    skipInstall: false,
    skipTests: false,
  };

  for (const argument of args) {
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--android-aab") options.androidAab = true;
    else if (argument === "--install") options.forceInstall = true;
    else if (argument === "--skip-install") options.skipInstall = true;
    else if (argument === "--skip-tests") options.skipTests = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown release option: ${argument}`);
  }

  if (options.forceInstall && options.skipInstall) {
    throw new Error("--install and --skip-install cannot be used together");
  }
  return options;
}

export function createLocalReleasePlan(platform, options = {}) {
  if (!SUPPORTED_RELEASE_PLATFORMS.includes(platform)) {
    throw new Error(`Local Release builds support Windows and macOS, received ${platform}`);
  }
  const steps = [];
  if (!options.skipTests) {
    steps.push(
      step("项目测试", "npm", ["test", "--", "--run"]),
      step("TypeScript 类型检查", "npm", ["run", "typecheck"]),
      step("nkg-ai-flow 全量测试", "npm", ["run", "test:nkg"]),
      step("nkg-ai-flow 浏览器边界", "npm", ["run", "test:nkg:browser"]),
      step("内置 Flow 审计", "npm", ["run", "test:example-flows"]),
      step("Rust 测试", "npm", ["run", "rust:test"]),
    );
  }

  if (platform === "win32") {
    const androidArgs = [
      "run", "android:build", "--", "--target", "aarch64", "--apk",
      ...(options.androidAab ? ["--aab"] : []),
      "--max-apk-mib", "40",
    ];
    steps.push(
      step("安装 Android Rust 目标", "rustup", ["target", "add", "aarch64-linux-android"]),
      step("Windows MSI Release", "npm", ["run", "tauri", "--", "build", "--bundles", "msi"]),
      step("Android arm64 Release", "npm", androidArgs),
    );
    return {
      platform,
      productKinds: [
        "windows-msi",
        "android-apk",
        ...(options.androidAab ? ["android-aab"] : []),
      ],
      steps,
    };
  }

  steps.push(step("安装 iOS Rust 目标", "rustup", ["target", "add", "aarch64-apple-ios"]));
  steps.push(
    step("macOS DMG Release", "npm", ["run", "tauri", "--", "build", "--bundles", "dmg"]),
    { kind: "ios-init", label: "检查 iOS 工程" },
    step("iOS App Store IPA", "npm", [
      "run", "ios:build", "--", "--export-method", "app-store-connect", "--ci",
    ]),
  );

  return {
    platform,
    productKinds: ["macos-dmg", "ios-ipa"],
    steps,
  };
}

export function formatCommand(command, args) {
  return [command, ...args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(" ");
}

function step(label, command, args) {
  return { kind: "command", label, command, args };
}
