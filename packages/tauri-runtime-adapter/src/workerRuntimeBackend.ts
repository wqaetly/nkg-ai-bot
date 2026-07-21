import type { NodeEvent } from "@ai-native-flow/event-bus";
import type { RuntimeWorkerEndpoint } from "@ai-native-flow/runtime/worker";
import { RuntimeWorkerClient } from "@ai-native-flow/runtime/worker";
import type {
  RuntimeBackend,
  RuntimeHttpHandler,
} from "@nkg-ai-bot/runtime-router";

export interface WorkerRuntimeEndpoint extends RuntimeWorkerEndpoint {
  terminate(): void;
}

export interface CreateWorkerRuntimeBackendOptions {
  createWorker: () => WorkerRuntimeEndpoint;
  attachCapabilities?: (worker: WorkerRuntimeEndpoint) => () => void;
}

export function createWorkerRuntimeBackend(
  options: CreateWorkerRuntimeBackendOptions,
): RuntimeBackend {
  let worker: WorkerRuntimeEndpoint | undefined;
  let client: RuntimeWorkerClient | undefined;
  let handler: RuntimeHttpHandler | undefined;
  let detachCapabilities: (() => void) | undefined;
  return {
    kind: "in-process",
    async start() {
      if (worker) return;
      worker = options.createWorker();
      detachCapabilities = options.attachCapabilities?.(worker);
      client = new RuntimeWorkerClient({ endpoint: worker });
      await client.ready();
      handler = createWorkerRuntimeHttpHandler(client);
    },
    request(_path, _init) {
      if (!handler) throw new Error("Worker Runtime backend is not started");
      return handler(new Request(new URL(_path, "http://runtime.worker"), _init));
    },
    async stop() {
      detachCapabilities?.();
      client?.dispose();
      worker?.terminate();
      detachCapabilities = undefined;
      client = undefined;
      handler = undefined;
      worker = undefined;
    },
  };
}

export function createWorkerRuntimeHttpHandler(client: RuntimeWorkerClient): RuntimeHttpHandler {
  return async (request) => {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method.toUpperCase();
      if (path === "/flows/register" && method === "POST") {
        const body = await request.json() as { graph?: any };
        if (!body.graph?.id || !body.graph?.version) return error(400, "transport.invalid_input", "Invalid FlowGraph");
        await client.register({ graph: body.graph, json: JSON.stringify(body.graph) });
        await client.promote({ flowId: body.graph.id, flowVersion: body.graph.version });
        return new Response(null, { status: 204 });
      }
      const invokeNode = path.match(/^\/flows\/([^/]+)\/nodes\/([^/]+)\/invoke$/);
      if (invokeNode && method === "POST") {
        const body = await request.json() as InvokeBody;
        const result = await client.invokeNode(toNodeArgs(invokeNode, body));
        return resultResponse(result, decodeURIComponent(invokeNode[2]!));
      }
      const invoke = path.match(/^\/flows\/([^/]+)\/invoke$/);
      if (invoke && method === "POST") {
        const body = await request.json() as InvokeBody;
        const result = await client.invoke(toArgs(decodeURIComponent(invoke[1]!), body));
        return resultResponse(result);
      }
      const streamNode = path.match(/^\/flows\/([^/]+)\/nodes\/([^/]+)\/stream$/);
      if (streamNode && method === "POST") {
        const body = await request.json() as InvokeBody;
        return streamResponse(client, () => client.startNode(toNodeArgs(streamNode, body)), request.signal);
      }
      const stream = path.match(/^\/flows\/([^/]+)\/stream$/);
      if (stream && method === "POST") {
        const body = await request.json() as InvokeBody;
        return streamResponse(
          client,
          () => client.start(toArgs(decodeURIComponent(stream[1]!), body)),
          request.signal,
        );
      }
      const run = path.match(/^\/runs\/([^/]+)$/);
      if (run && method === "GET") {
        const record = await client.getRun(decodeURIComponent(run[1]!));
        return record ? json(200, record) : error(404, "transport.not_found", "Run not found");
      }
      const events = path.match(/^\/runs\/([^/]+)\/events$/);
      if (events && method === "GET") {
        const value = await client.getEvents(
          decodeURIComponent(events[1]!),
          url.searchParams.get("cursor") ?? undefined,
          numeric(url.searchParams.get("limit")),
        );
        return json(200, { events: value });
      }
      const cancel = path.match(/^\/runs\/([^/]+)\/cancel$/);
      if (cancel && method === "POST") {
        await client.cancel(decodeURIComponent(cancel[1]!));
        return new Response(null, { status: 204 });
      }
      return error(404, "transport.not_found", `Unknown Runtime route: ${path}`);
    } catch (cause) {
      return error(500, "runtime.worker_failed", cause instanceof Error ? cause.message : String(cause));
    }
  };
}

interface InvokeBody {
  input?: unknown;
  nodeInput?: unknown;
  flowVersion?: string;
  traceId?: string;
  envOverrides?: {
    variables?: Record<string, string | number | boolean | null>;
    secrets?: Record<string, string>;
  };
  nodeOverrides?: unknown;
}

function toArgs(flowId: string, body: InvokeBody) {
  if (body.nodeOverrides) throw new Error("Worker Runtime does not yet support nodeOverrides");
  return {
    flowId,
    input: body.input ?? null,
    ...(body.flowVersion ? { flowVersion: body.flowVersion } : {}),
    ...(body.traceId ? { traceId: body.traceId } : {}),
    ...(body.envOverrides ? { envOverrides: body.envOverrides } : {}),
  };
}

function toNodeArgs(match: RegExpMatchArray, body: InvokeBody) {
  return {
    ...toArgs(decodeURIComponent(match[1]!), { ...body, input: body.nodeInput ?? body.input }),
    nodeId: decodeURIComponent(match[2]!),
  };
}

async function streamResponse(
  client: RuntimeWorkerClient,
  start: () => ReturnType<RuntimeWorkerClient["start"]>,
  signal: AbortSignal,
): Promise<Response> {
  const buffered: NodeEvent[] = [];
  let runId: string | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const unsubscribe = client.subscribe((event) => {
    if (!runId) {
      buffered.push(event);
      return;
    }
    if (event.runId === runId) emit(event);
  });
  const started = await start();
  runId = started.runRecord.runId;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      for (const event of buffered) if (event.runId === runId) emit(event);
      buffered.length = 0;
      if (signal.aborted) void client.cancel(runId!, "request aborted");
      else signal.addEventListener("abort", () => void client.cancel(runId!, "request aborted"), { once: true });
      void started.completed.finally(() => close());
    },
    cancel() {
      void client.cancel(runId!, "stream consumer cancelled");
      close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-nkg-run-id": runId,
      "access-control-expose-headers": "x-nkg-run-id",
    },
  });

  function emit(event: NodeEvent): void {
    controller?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  }
  function close(): void {
    unsubscribe();
    if (!controller) return;
    const value = controller;
    controller = undefined;
    try { value.close(); } catch { /* already closed */ }
  }
}

function resultResponse(result: any, nodeId?: string): Response {
  return json(result.succeeded ? 200 : result.cancelled ? 499 : 500, {
    runId: result.runRecord.runId,
    flowId: result.runRecord.flowId,
    flowVersion: result.runRecord.flowVersion,
    status: result.runRecord.status,
    output: result.output ?? null,
    error: result.error ?? null,
    ...(nodeId ? { nodeId } : {}),
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function error(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

function numeric(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
