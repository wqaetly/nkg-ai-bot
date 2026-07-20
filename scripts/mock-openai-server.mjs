import { createServer } from "node:http";

const host = process.env.NKG_MOCK_HOST ?? "127.0.0.1";
const port = Number(process.env.NKG_MOCK_PORT ?? "11434");
const expectedKey = process.env.NKG_MOCK_API_KEY ?? "local-test-key";
const chunkDelayMs = nonNegativeNumber(process.env.NKG_MOCK_CHUNK_DELAY_MS, 0);
let requestSequence = 0;

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }

  let raw = "";
  for await (const chunk of request) raw += chunk.toString();
  const body = JSON.parse(raw);
  const requestId = ++requestSequence;
  const authorization = request.headers.authorization ?? "";
  const accepted = authorization === `Bearer ${expectedKey}`;
  process.stdout.write(`${JSON.stringify({
    at: new Date().toISOString(),
    requestId,
    path: request.url,
    authorized: accepted,
    model: body.model,
    stream: body.stream,
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
  })}\n`);
  if (!accepted) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "invalid API key" } }));
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let completed = false;
  response.once("close", () => {
    process.stdout.write(`${JSON.stringify({ requestId, connectionClosed: true, completed })}\n`);
  });
  const chunks = ["Android ", "原生 HTTP ", "与 Flow 流式执行成功。"];
  for (const content of chunks) {
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-android-e2e",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`);
    if (chunkDelayMs > 0) await delay(chunkDelayMs);
  }
  if (response.destroyed) return;
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-android-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  completed = true;
  response.end("data: [DONE]\n\n");
});

server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({ ready: true, host, port })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function nonNegativeNumber(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number, received: ${value}`);
  }
  return parsed;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
