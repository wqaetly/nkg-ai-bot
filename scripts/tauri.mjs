import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { prepareZvec } from "./zvec-sdk.mjs";
import {
  createAndroidRustEnvironment,
  createRustEnvironment,
  createSourceRustEnvironment,
} from "./rust-env.mjs";

const args = process.argv.slice(2);
const command = args[0];
const buildsDesktopRust = command === "build" || command === "dev";
const buildsAndroidRust = command === "android";
const buildsIosRust = command === "ios";
const androidTarget = buildsAndroidRust ? readAndroidTarget(args) : undefined;
const env = buildsDesktopRust
  ? await createRustEnvironment()
  : buildsAndroidRust
    ? await createAndroidRustEnvironment(androidTarget)
    : buildsIosRust
      ? await createSourceRustEnvironment()
      : { ...process.env };
const require = createRequire(import.meta.url);
if (buildsDesktopRust || buildsAndroidRust || buildsIosRust) {
  const targetIndex = args.findIndex((arg) => arg === "--target" || arg === "-t");
  const explicitTarget = args.find((arg) => arg.startsWith("--target="))?.slice(9)
    ?? (targetIndex >= 0 ? args[targetIndex + 1] : undefined);
  await prepareZvec(env, buildsAndroidRust ? { platform: "android", arch: androidTarget ?? "aarch64" }
    : buildsIosRust ? {
      platform: "ios",
      arch: explicitTarget?.split("-")[0] ?? "arm64",
      simulator: /simulator/i.test([env.SDKROOT, env.PLATFORM_NAME, env.SDK_NAME].join(" "))
        || /sim/.test(explicitTarget ?? ""),
    } : {
      arch: explicitTarget?.split("-")[0] ?? process.arch,
    });
}
const cli = require.resolve("@tauri-apps/cli/tauri.js");

const child = spawn(process.execPath, [cli, ...args], { env, stdio: "inherit" });
child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

function readAndroidTarget(cliArgs) {
  const subcommand = cliArgs[1];
  if (!["build", "dev", "android-studio-script"].includes(subcommand)) return undefined;
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) return undefined;
  const equalsArgument = cliArgs.find((argument) => argument.startsWith("--target="));
  if (equalsArgument) return equalsArgument.slice("--target=".length);
  const index = cliArgs.findIndex((argument) => argument === "--target" || argument === "-t");
  if (index >= 0 && cliArgs[index + 1] && !cliArgs[index + 1].startsWith("-")) {
    const target = cliArgs[index + 1];
    if (cliArgs[index + 2] && !cliArgs[index + 2].startsWith("-")) {
      throw new Error(
        "Windows Android builds currently require one --target per command so libsodium can be linked for the correct ABI.",
      );
    }
    return target;
  }
  throw new Error(
    "Windows Android builds require an explicit target: --target aarch64, armv7, i686, or x86_64.",
  );
}
