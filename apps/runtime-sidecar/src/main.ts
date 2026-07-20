import { AiSdkOpenAICompatibleLlmProvider } from "../../../nkg-ai-flow/packages/runtime/src/index.js";
import { startHttpRunner } from "../../../nkg-ai-flow/packages/transports/http-runner/src/index.js";

const token = process.env.ANF_RUNTIME_TOKEN?.trim();
if (!token) fatal("ANF_RUNTIME_TOKEN is required");

const hostname = "127.0.0.1";
const runner = await startHttpRunner({
  hostname,
  port: readPort(process.env.ANF_HTTP_PORT),
  token,
  builtinRootDir: null,
  cors: ["http://localhost:1420", "http://tauri.localhost", "tauri://localhost"],
  llmProvider: new AiSdkOpenAICompatibleLlmProvider(),
});

process.stdout.write(`${JSON.stringify({
  kind: "ready",
  url: runner.url,
  port: runner.port,
})}\n`);

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await runner.stop();
    process.stdout.write(`${JSON.stringify({ kind: "stopped", signal })}\n`);
    process.exit(0);
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error));
  }
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("uncaughtException", (error) => fatal(error.message));
process.once("unhandledRejection", (error) => fatal(error instanceof Error ? error.message : String(error)));

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    fatal(`Invalid ANF_HTTP_PORT: ${raw}`);
  }
  return port;
}

function fatal(message: string): never {
  process.stderr.write(`${JSON.stringify({ kind: "fatal", message })}\n`);
  process.exit(1);
}
