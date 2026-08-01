import type {
  FlowInvokeOptions,
  FlowInvokeResult,
  NodeEvent,
  RunRecord,
} from "@nkg-ai-bot/runtime-router";
import type { FlowRuntimeClient } from "@nkg-ai-bot/runtime-router";
import { providerSession, type ProviderSession } from "./providerSession";
import {
  isTerminalRunEvent,
  RuntimeExecutionTracker,
  type RuntimeSuspensionResult,
} from "./runtimeExecutionTracker";

type RuntimeClientPort = Pick<
  FlowRuntimeClient,
  "registerFlow" | "invoke" | "invokeNode" | "stream" | "streamNode" | "getRun" | "getEvents" | "cancel"
>;

export type PrepareRuntimeExecution = (signal?: AbortSignal) => Promise<void>;

/**
 * App-facing Runtime client. Provider secrets are resolved immediately before
 * an invocation and never retained by this wrapper.
 */
export class ProviderFlowRuntimeClient {
  private readonly executions: RuntimeExecutionTracker;

  constructor(
    private readonly runtime: RuntimeClientPort,
    private readonly providers: ProviderSession = providerSession,
    private readonly prepareExecution: PrepareRuntimeExecution = async () => undefined,
  ) {
    this.executions = new RuntimeExecutionTracker(runtime);
  }

  registerFlow(graph: unknown, signal?: AbortSignal): Promise<void> {
    return this.runtime.registerFlow(graph, signal);
  }

  async invoke(
    flowId: string,
    input: unknown,
    options: FlowInvokeOptions = {},
  ): Promise<FlowInvokeResult> {
    await this.prepareExecution(options.signal);
    const execution = this.executions.begin(options.signal);
    let runOptions: FlowInvokeOptions | undefined;
    try {
      runOptions = await this.providers.createRunOptions(
        { ...options, signal: execution.signal },
        { flowId },
      );
      return await this.runtime.invoke(
        flowId,
        input,
        runOptions,
      );
    } catch (cause: unknown) {
      throw normalizeExecutionError(cause, execution.signal);
    } finally {
      if (runOptions) await this.completeRunOptions(runOptions);
      execution.finish();
    }
  }

  async invokeNode(
    flowId: string,
    nodeId: string,
    input: unknown,
    options: FlowInvokeOptions = {},
  ): Promise<FlowInvokeResult> {
    await this.prepareExecution(options.signal);
    const execution = this.executions.begin(options.signal);
    let runOptions: FlowInvokeOptions | undefined;
    try {
      runOptions = await this.providers.createRunOptions(
        { ...options, signal: execution.signal },
        { flowId },
      );
      return await this.runtime.invokeNode(
        flowId,
        nodeId,
        input,
        runOptions,
      );
    } catch (cause: unknown) {
      throw normalizeExecutionError(cause, execution.signal);
    } finally {
      if (runOptions) await this.completeRunOptions(runOptions);
      execution.finish();
    }
  }

  async *stream(
    flowId: string,
    input: unknown,
    options: FlowInvokeOptions = {},
  ): AsyncIterable<NodeEvent> {
    await this.prepareExecution(options.signal);
    const execution = this.executions.begin(options.signal);
    let runOptions: FlowInvokeOptions | undefined;
    try {
      runOptions = await this.providers.createRunOptions({
        ...options,
        signal: execution.signal,
        onRunStarted: (runId) => {
          execution.observeRun(runId);
          options.onRunStarted?.(runId);
        },
      }, { flowId });
      for await (const event of this.runtime.stream(flowId, input, runOptions)) {
        execution.observeRun(event.runId);
        if (isTerminalRunEvent(event.kind)) execution.observeTerminal();
        yield event;
      }
    } catch (cause: unknown) {
      throw normalizeExecutionError(cause, execution.signal);
    } finally {
      if (runOptions) await this.completeRunOptions(runOptions);
      execution.finish();
    }
  }

  async *streamNode(
    flowId: string,
    nodeId: string,
    input: unknown,
    options: FlowInvokeOptions = {},
  ): AsyncIterable<NodeEvent> {
    await this.prepareExecution(options.signal);
    const execution = this.executions.begin(options.signal);
    let runOptions: FlowInvokeOptions | undefined;
    try {
      runOptions = await this.providers.createRunOptions({
        ...options,
        signal: execution.signal,
        onRunStarted: (runId) => {
          execution.observeRun(runId);
          options.onRunStarted?.(runId);
        },
      }, { flowId });
      for await (const event of this.runtime.streamNode(flowId, nodeId, input, runOptions)) {
        execution.observeRun(event.runId);
        if (isTerminalRunEvent(event.kind)) execution.observeTerminal();
        yield event;
      }
    } catch (cause: unknown) {
      throw normalizeExecutionError(cause, execution.signal);
    } finally {
      if (runOptions) await this.completeRunOptions(runOptions);
      execution.finish();
    }
  }

  getRun(runId: string, signal?: AbortSignal): Promise<RunRecord> {
    return this.runtime.getRun(runId, signal);
  }

  getEvents(
    runId: string,
    options?: { cursor?: string; limit?: number; signal?: AbortSignal },
  ): Promise<NodeEvent[]> {
    return this.runtime.getEvents(runId, options);
  }

  cancel(runId: string, signal?: AbortSignal): Promise<void> {
    return this.runtime.cancel(runId, signal);
  }

  suspendActiveExecutions(): Promise<RuntimeSuspensionResult> {
    return this.executions.suspend();
  }

  private async completeRunOptions(options: FlowInvokeOptions): Promise<void> {
    const complete = (this.providers as ProviderSession & {
      completeRunOptions?: (value: FlowInvokeOptions) => Promise<void>;
    }).completeRunOptions;
    if (typeof complete !== "function") return;
    await complete.call(this.providers, options).catch((cause: unknown) => {
      console.warn("Unable to complete NKG AI run authorization", cause);
    });
  }
}

/** Explicit user/lifecycle cancellation wins races with lower-level I/O errors. */
function normalizeExecutionError(cause: unknown, signal: AbortSignal): unknown {
  if (!signal.aborted) return cause;
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Flow execution was cancelled", "AbortError");
}
