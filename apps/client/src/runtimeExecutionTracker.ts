import type { FlowRuntimeClient } from "@nkg-ai-bot/runtime-router";

type CancellationClient = Pick<FlowRuntimeClient, "cancel">;

interface ActiveExecution {
  controller: AbortController;
  cleanupExternalSignal: () => void;
  runId?: string;
  terminal: boolean;
}

export interface ExecutionLease {
  readonly signal: AbortSignal;
  observeRun(runId: string): void;
  observeTerminal(): void;
  finish(): void;
}

export interface RuntimeSuspensionResult {
  abortedExecutions: number;
  cancellationRequests: number;
  cancellationFailures: Array<{ runId: string; message: string }>;
}

/** Tracks app-owned Flow executions so mobile suspension can stop them cleanly. */
export class RuntimeExecutionTracker {
  private readonly active = new Set<ActiveExecution>();

  constructor(private readonly runtime: CancellationClient) {}

  begin(externalSignal?: AbortSignal): ExecutionLease {
    const controller = new AbortController();
    const cleanupExternalSignal = forwardAbort(externalSignal, controller);
    const execution: ActiveExecution = {
      controller,
      cleanupExternalSignal,
      terminal: false,
    };
    this.active.add(execution);

    let finished = false;
    return {
      signal: controller.signal,
      observeRun: (runId) => {
        if (!finished && !execution.terminal) execution.runId = runId;
      },
      observeTerminal: () => {
        execution.terminal = true;
        delete execution.runId;
      },
      finish: () => {
        if (finished) return;
        finished = true;
        cleanupExternalSignal();
        this.active.delete(execution);
      },
    };
  }

  async suspend(): Promise<RuntimeSuspensionResult> {
    const executions = [...this.active];
    const runIds = [...new Set(
      executions
        .filter((execution) => !execution.terminal)
        .map((execution) => execution.runId)
        .filter((runId): runId is string => runId !== undefined),
    )];

    // Start runtime cancellation before aborting the SSE consumers. The
    // cancellation route uses a separate request from the tracked stream.
    const cancellations = runIds.map(async (runId) => {
      try {
        await this.runtime.cancel(runId);
        return undefined;
      } catch (error: unknown) {
        return {
          runId,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });

    for (const execution of executions) {
      execution.cleanupExternalSignal();
      execution.controller.abort(new DOMException(
        "Flow execution was suspended with the application",
        "AbortError",
      ));
      this.active.delete(execution);
    }

    return {
      abortedExecutions: executions.length,
      cancellationRequests: runIds.length,
      cancellationFailures: (await Promise.all(cancellations)).filter(
        (failure): failure is { runId: string; message: string } => failure !== undefined,
      ),
    };
  }
}

export function isTerminalRunEvent(kind: string): boolean {
  return kind === "run_finished" || kind === "run_failed" || kind === "run_cancelled";
}

function forwardAbort(
  externalSignal: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!externalSignal) return () => undefined;
  if (externalSignal.aborted) {
    controller.abort(externalSignal.reason);
    return () => undefined;
  }

  const abort = () => controller.abort(externalSignal.reason);
  externalSignal.addEventListener("abort", abort, { once: true });
  return () => externalSignal.removeEventListener("abort", abort);
}
