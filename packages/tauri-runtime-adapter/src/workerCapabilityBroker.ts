import type {
  AgentToolCall,
  AgentToolHost,
  AgentToolName,
  AgentToolResult,
} from "@ai-native-flow/runtime/agent-tools";
import type { RuntimeWorkerEndpoint } from "@ai-native-flow/runtime/worker/host";

const PROTOCOL = "runtime.capability.v1" as const;

interface CapabilityRequest {
  protocol: typeof PROTOCOL;
  kind: "capability_request";
  requestId: string;
  call: AgentToolCall;
  env: ToolEnvironment;
}

interface CapabilityResponse {
  protocol: typeof PROTOCOL;
  kind: "capability_response";
  requestId: string;
  result: AgentToolResult;
}

interface FetchRequest {
  protocol: typeof PROTOCOL;
  kind: "fetch_request";
  requestId: string;
  url: string;
  init: RequestInit;
}

interface FetchResponse {
  protocol: typeof PROTOCOL;
  kind: "fetch_response";
  requestId: string;
  response?: {
    status: number;
    statusText: string;
    headers: Array<[string, string]>;
  };
  error?: string;
}

interface FetchChunk {
  protocol: typeof PROTOCOL;
  kind: "fetch_chunk";
  requestId: string;
  chunk: ArrayBuffer;
}

interface FetchEnd {
  protocol: typeof PROTOCOL;
  kind: "fetch_end";
  requestId: string;
  error?: string;
}

interface FetchCancel {
  protocol: typeof PROTOCOL;
  kind: "fetch_cancel";
  requestId: string;
}

interface ToolEnvironment {
  workingDir: string;
  allowedTools: readonly AgentToolName[];
  allowBash: boolean;
  timeoutMs: number;
  maxOutputChars: number;
  context?: Record<string, unknown>;
  runtime?: {
    flowId: string;
    flowVersion: string;
    runId: string;
    nodeId: string;
  };
}

export interface CapabilityAuthorizationScope {
  flowId: string;
  flowVersion: string;
  runId: string;
  nodeId: string;
  capability: "filesystem.read" | "filesystem.write" | "process.spawn";
}

/** Worker-side host: forwards native tool calls to the UI/Tauri broker. */
export function createBrokeredAgentToolHost(
  endpoint: RuntimeWorkerEndpoint,
): AgentToolHost {
  let nextId = 0;
  const pending = new Map<string, (result: AgentToolResult) => void>();
  endpoint.addEventListener("message", (event) => {
    const message = event.data as Partial<CapabilityResponse>;
    if (message.protocol !== PROTOCOL || message.kind !== "capability_response") return;
    const resolve = message.requestId ? pending.get(message.requestId) : undefined;
    if (!resolve || !message.result) return;
    pending.delete(message.requestId!);
    resolve(message.result);
  });
  return {
    callTool(call, env) {
      const requestId = `capability_${++nextId}`;
      return new Promise((resolve) => {
        pending.set(requestId, resolve);
        endpoint.postMessage({
          protocol: PROTOCOL,
          kind: "capability_request",
          requestId,
          call,
          env,
        } satisfies CapabilityRequest);
      });
    },
  };
}

/** Worker-side fetch that delegates network I/O to the Tauri/WebView host. */
export function createBrokeredFetch(endpoint: RuntimeWorkerEndpoint): typeof fetch {
  let nextId = 0;
  const pending = new Map<string, {
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }>();
  const streams = new Map<string, {
    controller: ReadableStreamDefaultController<Uint8Array>;
    signal?: AbortSignal;
    abort?: () => void;
  }>();
  endpoint.addEventListener("message", (event) => {
    const message = event.data as {
      protocol?: unknown;
      kind?: string;
      requestId?: string;
      chunk?: ArrayBuffer;
      response?: FetchResponse["response"];
      error?: string;
    };
    if (message.protocol !== PROTOCOL || !message.requestId) return;
    if (message.kind === "fetch_chunk") {
      const stream = streams.get(message.requestId);
      if (stream && message.chunk) stream.controller.enqueue(new Uint8Array(message.chunk));
      return;
    }
    if (message.kind === "fetch_end") {
      const stream = streams.get(message.requestId);
      if (!stream) return;
      streams.delete(message.requestId);
      stream.signal?.removeEventListener("abort", stream.abort!);
      if (message.error) stream.controller.error(new Error(message.error));
      else stream.controller.close();
      return;
    }
    if (message.kind !== "fetch_response") return;
    const operation = pending.get(message.requestId);
    if (!operation) return;
    pending.delete(message.requestId);
    if (message.error || !message.response) {
      operation.signal?.removeEventListener("abort", operation.abort!);
      operation.reject(new Error(message.error ?? "Native fetch broker returned no response"));
      return;
    }
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        endpoint.postMessage({
          protocol: PROTOCOL,
          kind: "fetch_cancel",
          requestId: message.requestId!,
        } satisfies FetchCancel);
      },
    });
    streams.set(message.requestId, {
      controller: streamController,
      ...(operation.signal ? { signal: operation.signal } : {}),
      ...(operation.abort ? { abort: operation.abort } : {}),
    });
    operation.resolve(new Response(body, {
      status: message.response.status,
      statusText: message.response.statusText,
      headers: message.response.headers,
    }));
  });
  return async (input, init) => {
    const request = new Request(input, init);
    const requestId = `fetch_${++nextId}`;
    const serializableInit: RequestInit = {
      method: request.method,
      headers: [...request.headers.entries()],
      ...(request.method !== "GET" && request.method !== "HEAD"
        ? { body: await request.arrayBuffer() }
        : {}),
    };
    return new Promise<Response>((resolve, reject) => {
      const abort = () => {
        pending.delete(requestId);
        const stream = streams.get(requestId);
        streams.delete(requestId);
        stream?.controller.error(request.signal.reason ?? new DOMException("Aborted", "AbortError"));
        endpoint.postMessage({
          protocol: PROTOCOL,
          kind: "fetch_cancel",
          requestId,
        } satisfies FetchCancel);
        reject(request.signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (request.signal.aborted) {
        abort();
        return;
      }
      request.signal.addEventListener("abort", abort, { once: true });
      pending.set(requestId, { resolve, reject, signal: request.signal, abort });
      endpoint.postMessage({
        protocol: PROTOCOL,
        kind: "fetch_request",
        requestId,
        url: request.url,
        init: serializableInit,
      } satisfies FetchRequest);
    });
  };
}

/** UI-side broker: executes requests through the policy-enforcing Tauri host. */
export function attachTauriCapabilityBroker(
  endpoint: RuntimeWorkerEndpoint,
  toolHost: AgentToolHost,
  fetchImpl: typeof fetch = globalThis.fetch,
  authorize?: (scope: CapabilityAuthorizationScope) => boolean | Promise<boolean>,
): () => void {
  const fetches = new Map<string, AbortController>();
  const listener = (event: { data: unknown }) => {
    if (!event.data || typeof event.data !== "object") return;
    const envelope = event.data as { protocol?: unknown; kind?: unknown };
    if (envelope.protocol !== PROTOCOL) return;
    const cancel = event.data as Partial<FetchCancel>;
    if (cancel.kind === "fetch_cancel" && cancel.requestId) {
      fetches.get(cancel.requestId)?.abort();
      return;
    }
    const request = event.data as Partial<FetchRequest>;
    if (
      request.protocol === PROTOCOL &&
      request.kind === "fetch_request" &&
      request.requestId &&
      request.url &&
      request.init
    ) {
      const abortController = new AbortController();
      fetches.set(request.requestId, abortController);
      let started = false;
      void fetchImpl(request.url, { ...request.init, signal: abortController.signal }).then(async (response) => {
        endpoint.postMessage({
          protocol: PROTOCOL,
          kind: "fetch_response",
          requestId: request.requestId!,
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: [...response.headers.entries()],
          },
        } satisfies FetchResponse);
        started = true;
        if (response.body) {
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            endpoint.postMessage({
              protocol: PROTOCOL,
              kind: "fetch_chunk",
              requestId: request.requestId!,
              chunk: new Uint8Array(value).buffer,
            } satisfies FetchChunk);
          }
        }
        endpoint.postMessage({
          protocol: PROTOCOL,
          kind: "fetch_end",
          requestId: request.requestId!,
        } satisfies FetchEnd);
      }).catch((cause) => {
        const error = cause instanceof Error ? cause.message : String(cause);
        endpoint.postMessage(started
          ? { protocol: PROTOCOL, kind: "fetch_end", requestId: request.requestId!, error } satisfies FetchEnd
          : { protocol: PROTOCOL, kind: "fetch_response", requestId: request.requestId!, error } satisfies FetchResponse);
      }).finally(() => {
        fetches.delete(request.requestId!);
      });
      return;
    }
    const capabilityRequest = event.data as Partial<CapabilityRequest>;
    if (
      capabilityRequest.kind !== "capability_request" ||
      !capabilityRequest.requestId ||
      !capabilityRequest.call ||
      !capabilityRequest.env
    ) return;
    const capability = toolCapability(capabilityRequest.call.tool);
    const runtime = capabilityRequest.env.runtime;
    const authorization = authorize && capability
      ? runtime
        ? authorize({ ...runtime, capability })
        : false
      : true;
    void Promise.resolve(authorization).then((authorized) => {
      if (!authorized) {
        return {
          ok: false,
          error: `capability ${capability} is not authorized for flow ${runtime?.flowId ?? "unknown"}`,
          output: { code: "runtime.capability_not_authorized", capability },
        } satisfies AgentToolResult;
      }
      return toolHost.callTool(capabilityRequest.call!, capabilityRequest.env!);
    }).then(
      (result) => respond(endpoint, capabilityRequest.requestId!, result),
      (cause) => respond(endpoint, capabilityRequest.requestId!, {
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  };
  endpoint.addEventListener("message", listener);
  return () => {
    endpoint.removeEventListener?.("message", listener);
    for (const controller of fetches.values()) controller.abort();
    fetches.clear();
  };
}

function toolCapability(
  tool: AgentToolName,
): CapabilityAuthorizationScope["capability"] | undefined {
  if (["list_files", "read_file", "grep"].includes(tool)) return "filesystem.read";
  if (["edit_file", "write_files"].includes(tool)) return "filesystem.write";
  if (tool === "run_bash") return "process.spawn";
  return undefined;
}

function respond(
  endpoint: RuntimeWorkerEndpoint,
  requestId: string,
  result: AgentToolResult,
): void {
  endpoint.postMessage({
    protocol: PROTOCOL,
    kind: "capability_response",
    requestId,
    result,
  } satisfies CapabilityResponse);
}
