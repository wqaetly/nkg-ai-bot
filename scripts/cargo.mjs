import { spawn } from "node:child_process";
import { join } from "node:path";
import { createRustEnvironment } from "./rust-env.mjs";
import { prepareZvec } from "./zvec-sdk.mjs";

const args = process.argv.slice(2);
const env = await createRustEnvironment();
await prepareZvec(env);
const cargo = process.platform === "win32"
  ? join(process.env.USERPROFILE ?? "", ".cargo", "bin", "cargo.exe")
  : "cargo";

const child = spawn(cargo, args, { env, stdio: "inherit" });
child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
