import type {
  FlowInvokeOptions,
  FlowInvokeResult,
  NodeEvent,
  RunRecord,
  RuntimeErrorBody,
} from "./contracts.js";
import { RuntimeRouteError } from "./contracts.js";
import { RuntimeTransportError } from "./contracts.js";
import type { RuntimeRouter } from "./runtimeRouter.js";
import { parseServerSentEvents } from "./sse.js";

export class FlowRuntimeClient {
  constructor(private readonly router: RuntimeRouter) {}

  async registerFlow(graph: unknown, signal?: AbortSignal): Promise<void> {
    const response = await this.router.request("/flows/register", jsonInit({ graph }, signal));
    await expectOk(response);
  }

  async invoke(
    flowId: string,
    input: unknown,
    options: FlowInvokeOptions = {},
  ): Promise<FlowInvokeResult> {
    return this.invokePath(`/flows/${encodeURIComponent(flowId)}/invoke`, input, options);
  }

  async invokeNode(
    flowId: string,
    nodeId: string,
    input: unknown,
    options: FlowInvokeOptions = {},
  ): Promise<FlowInvokeResult> {
    const path = `/flows/${encodeURIComponent(flowId)}/nodes/${encodeURIComponent(nodeId)}/invoke`;
    return this.invokePath(path, input, options);
  }

  async *stream(
    flowId: string,
    input: unknown,
    options: FlowInvokeOptions = {},
  ): AsyncIterable<NodeEvent> {
    const path = `/flows/${encodeURIComponent(flowId)}/stream`;
    yield* this.streamPath(path, input, options);
  }

  async *streamNode(
    flowId: string,
    nodeId: string,
    input: unknown,
    options: FlowInvokeOptions = {},
  ): AsyncIterable<NodeEvent> {
    const path = `/flows/${encodeURIComponent(flowId)}/nodes/${encodeURIComponent(nodeId)}/stream`;
    yield* this.streamPath(path, input, options);
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<RunRecord> {
    const response = await this.router.request(
      `/runs/${encodeURIComponent(runId)}`,
      signal ? { signal } : undefined,
    );
    return readJson<RunRecord>(response);
  }

  async getEvents(
    runId: string,
    options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<NodeEvent[]> {
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size > 0 ? `?${query}` : "";
    const response = await this.router.request(
      `/runs/${encodeURIComponent(runId)}/events${suffix}`,
      options.signal ? { signal: options.signal } : undefined,
    );
    const body = await readJson<{ events: NodeEvent[] }>(response);
    return body.events;
  }

  async cancel(runId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.router.request(
      `/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST", ...(signal ? { signal } : {}) },
    );
    await expectOk(response);
  }

  private async invokePath(
    path: string,
    input: unknown,
    options: FlowInvokeOptions,
  ): Promise<FlowInvokeResult> {
    const response = await this.router.request(path, jsonInit(toInvokeBody(input, options), options.signal));
    return readJson<FlowInvokeResult>(response);
  }

  private async *streamPath(
    path: string,
    input: unknown,
    options: FlowInvokeOptions,
  ): AsyncIterable<NodeEvent> {
    const response = await this.router.request(path, {
      ...jsonInit(toInvokeBody(input, options), options.signal),
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
    });
    await expectOk(response);
    const responseRunId = response.headers.get("x-nkg-run-id");
    if (responseRunId) options.onRunStarted?.(responseRunId);
    if (!response.body) {
      throw new RuntimeRouteError("Runtime returned an empty SSE response", {
        status: response.status,
      });
    }
    let terminalEventObserved = false;
    try {
      for await (const message of parseServerSentEvents(response.body)) {
        if (!message.data || message.data === "[DONE]") continue;
        try {
          const event = JSON.parse(message.data) as NodeEvent;
          if (isTerminalRunEvent(event.kind)) terminalEventObserved = true;
          yield event;
          if (terminalEventObserved) return;
        } catch (cause) {
          if (cause instanceof RuntimeRouteError || cause instanceof RuntimeTransportError) {
            throw cause;
          }
          throw new RuntimeRouteError("Runtime returned invalid SSE JSON", {
            status: response.status,
            details: { data: message.data, cause: String(cause) },
          });
        }
      }
    } catch (cause: unknown) {
      if (isAbort(cause, options.signal) || cause instanceof RuntimeRouteError) throw cause;
      const interruption = streamInterruption(this.router.backendKind, cause);
      await this.router.reportResponseFailure(response, interruption, options.signal);
      throw interruption;
    }

    if (!terminalEventObserved) {
      const interruption = streamInterruption(
        this.router.backendKind,
        new Error("SSE response ended before a terminal run event"),
      );
      await this.router.reportResponseFailure(response, interruption, options.signal);
      throw interruption;
    }
  }
}

function isTerminalRunEvent(kind: string): boolean {
  return kind === "run_finished" || kind === "run_failed" || kind === "run_cancelled";
}

function streamInterruption(
  backend: RuntimeTransportError["backend"],
  cause: unknown,
): RuntimeTransportError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new RuntimeTransportError(
    `Runtime stream was interrupted before completion: ${detail}`,
    {
      backend,
      phase: "stream",
      requestMayHaveExecuted: true,
      cause,
    },
  );
}

function isAbort(cause: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    || (cause instanceof Error && cause.name === "AbortError");
}

function toInvokeBody(input: unknown, options: FlowInvokeOptions): Record<string, unknown> {
  return {
    input,
    ...(options.flowVersion !== undefined ? { flowVersion: options.flowVersion } : {}),
    ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
    ...(options.envOverrides !== undefined ? { envOverrides: options.envOverrides } : {}),
    ...(options.nodeOverrides !== undefined ? { nodeOverrides: options.nodeOverrides } : {}),
  };
}

function jsonInit(body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  };
}

async function readJson<T>(response: Response): Promise<T> {
  await expectOk(response);
  return await response.json() as T;
}

async function expectOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await readErrorBody(response);
  throw new RuntimeRouteError(
    body?.message ?? `Runtime request failed with HTTP ${response.status}`,
    {
      status: response.status,
      ...(body?.code !== undefined ? { code: body.code } : {}),
      ...(body?.details !== undefined ? { details: body.details } : {}),
    },
  );
}

async function readErrorBody(response: Response): Promise<RuntimeErrorBody | undefined> {
  try {
    const raw = await response.json() as unknown;
    if (!raw || typeof raw !== "object") return undefined;
    const candidate = "error" in raw
      ? (raw as { error?: unknown }).error
      : raw;
    if (!candidate || typeof candidate !== "object") return undefined;
    const message = (candidate as { message?: unknown }).message;
    if (typeof message !== "string") return undefined;
    const error = candidate as {
      message: string;
      code?: unknown;
      details?: unknown;
    };
    return {
      message: error.message,
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  } catch {
    return undefined;
  }
}
