import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { detectSidecarTarget } from "./sidecar-target.mjs";

const target = detectSidecarTarget();
const executable = resolve(
  import.meta.dirname,
  "..",
  "..",
  "client",
  "src-tauri",
  "binaries",
  target.outputName,
);
const token = `e2e-${crypto.randomUUID()}`;
const child = spawn(executable, [], {
  env: { ...process.env, ANF_RUNTIME_TOKEN: token, ANF_HTTP_PORT: "0" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  const ready = await waitForReady(child);
  const unauthorized = await fetch(ready.url);
  const authorized = await fetch(ready.url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await authorized.json();

  if (unauthorized.status !== 401) {
    throw new Error(`Expected unauthenticated request to return 401, got ${unauthorized.status}`);
  }
  if (!authorized.ok) {
    throw new Error(`Authenticated request failed with ${authorized.status}`);
  }
  if (ready.kind !== "ready" || !Array.isArray(body.flows)) {
    throw new Error("Runtime readiness response is malformed");
  }

  process.stdout.write(`${JSON.stringify({
    kind: ready.kind,
    origin: new URL(ready.url).origin,
    unauthorizedStatus: unauthorized.status,
    authorizedStatus: authorized.status,
    flowCount: body.flows.length,
  }, null, 2)}\n`);
} finally {
  if (child.exitCode === null) child.kill();
}

async function waitForReady(processHandle) {
  const lines = createInterface({ input: processHandle.stdout });
  const timeout = AbortSignal.timeout(20_000);

  return await new Promise((resolveReady, reject) => {
    const cleanup = () => {
      timeout.removeEventListener("abort", onTimeout);
      processHandle.removeListener("exit", onExit);
      lines.removeListener("line", onLine);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error(`Timed out waiting for sidecar readiness. ${stderr}`));
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Sidecar exited before readiness (${code}). ${stderr}`));
    };
    const onLine = (line) => {
      try {
        const event = JSON.parse(line);
        if (event.kind !== "ready") return;
        cleanup();
        resolveReady(event);
      } catch {
        // Ignore non-protocol output; only a valid ready event completes startup.
      }
    };

    timeout.addEventListener("abort", onTimeout, { once: true });
    processHandle.once("exit", onExit);
    lines.on("line", onLine);
  });
}
