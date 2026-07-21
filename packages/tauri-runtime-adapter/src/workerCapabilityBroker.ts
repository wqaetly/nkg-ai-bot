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
    body: ArrayBuffer;
  };
  error?: string;
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
  }>();
  endpoint.addEventListener("message", (event) => {
    const message = event.data as Partial<FetchResponse>;
    if (message.protocol !== PROTOCOL || message.kind !== "fetch_response" || !message.requestId) return;
    const operation = pending.get(message.requestId);
    if (!operation) return;
    pending.delete(message.requestId);
    if (message.error || !message.response) {
      operation.reject(new Error(message.error ?? "Native fetch broker returned no response"));
      return;
    }
    operation.resolve(new Response(message.response.body, {
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
      pending.set(requestId, { resolve, reject });
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
  const listener = (event: { data: unknown }) => {
    if (!event.data || typeof event.data !== "object") return;
    const envelope = event.data as { protocol?: unknown; kind?: unknown };
    if (envelope.protocol !== PROTOCOL) return;
    const request = event.data as Partial<FetchRequest>;
    if (
      request.protocol === PROTOCOL &&
      request.kind === "fetch_request" &&
      request.requestId &&
      request.url &&
      request.init
    ) {
      void fetchImpl(request.url, request.init).then(async (response) => {
        endpoint.postMessage({
          protocol: PROTOCOL,
          kind: "fetch_response",
          requestId: request.requestId!,
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: [...response.headers.entries()],
            body: await response.arrayBuffer(),
          },
        } satisfies FetchResponse);
      }, (cause) => {
        endpoint.postMessage({
          protocol: PROTOCOL,
          kind: "fetch_response",
          requestId: request.requestId!,
          error: cause instanceof Error ? cause.message : String(cause),
        } satisfies FetchResponse);
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
  return () => endpoint.removeEventListener?.("message", listener);
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
