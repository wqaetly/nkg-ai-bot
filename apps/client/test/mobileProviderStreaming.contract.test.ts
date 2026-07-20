import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTauriRuntimeServices,
  type TauriInvoke,
} from "../../../packages/tauri-runtime-adapter/src/index.js";
import { createNkgPortableRuntime } from "../../../packages/tauri-runtime-adapter/src/nkgPortableRuntime.js";
import { BUILTIN_CHAT_FLOW } from "../src/builtinFlows";
import { ProviderFlowRuntimeClient } from "../src/providerFlowClient";

const openServers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("mobile Provider streaming contract", () => {
  it.each(["android", "ios"] as const)(
    "executes the %s built-in Flow through a real OpenAI-compatible HTTP/SSE endpoint",
    async (platform) => {
      let received: { url?: string; authorization?: string; body?: Record<string, unknown> } = {};
      const server = createServer(async (request, response) => {
        received = {
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(await readBody(request)) as Record<string, unknown>,
        };
        writeOpenAiStream(response, ["跨平台", "流式", "成功"]);
      });
      openServers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("mock Provider did not bind a TCP port");

      const mobileRuntime = await createNkgPortableRuntime({ flows: [BUILTIN_CHAT_FLOW] });
      const services = createTauriRuntimeServices({
        platform,
        invoke: vi.fn() as TauriInvoke,
        createInProcessHandler: () => mobileRuntime.handler,
      });
      const client = new ProviderFlowRuntimeClient(services.client, {
        createRunOptions: async (options: Record<string, unknown>) => ({
          ...options,
          envOverrides: {
            variables: {
              LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
              LLM_DEFAULT_MODEL: "contract-model",
            },
            secrets: { LLM_API_KEY: "contract-secret" },
          },
        }),
      } as never);

      try {
        const deltas: string[] = [];
        let terminalKind = "";
        for await (const event of client.stream("builtin_chat", "验证移动端真实网络流", { flowVersion: "1.0.0" })) {
          if (event.kind === "stream_delta" && event.nodeId === "chat_model") {
            deltas.push((event.payload as { text: string }).text);
          }
          if (event.kind.startsWith("run_")) terminalKind = event.kind;
        }

        expect(deltas.join("")).toBe("跨平台流式成功");
        expect(terminalKind).toBe("run_finished");
        expect(received).toMatchObject({
          url: "/v1/chat/completions",
          authorization: "Bearer contract-secret",
          body: {
            model: "contract-model",
            stream: true,
          },
        });
        expect(JSON.stringify(received.body)).toContain("验证移动端真实网络流");
      } finally {
        await services.router.stop();
      }
    },
    15_000,
  );
});

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return body;
}

function writeOpenAiStream(response: ServerResponse, chunks: string[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const content of chunks) {
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-contract",
      object: "chat.completion.chunk",
      created: 1,
      model: "contract-model",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`);
  }
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-contract",
    object: "chat.completion.chunk",
    created: 1,
    model: "contract-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}
