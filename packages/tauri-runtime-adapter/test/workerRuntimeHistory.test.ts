import { describe, expect, it } from "vitest";
import { RUN_RECORD_SCHEMA_VERSION, type ExecuteResult } from "@ai-native-flow/runtime";
import {
  TauriWorkerRuntimeHistory,
  type SqliteRuntimeDatabase,
} from "../src/index.js";

class ScriptedDatabase implements SqliteRuntimeDatabase {
  readonly operations: Array<{ query: string; values: unknown[] }> = [];
  readonly results: unknown[] = [];
  failExecute?: (query: string, values: unknown[]) => Error | undefined;
  async execute(query: string, values: unknown[] = []) {
    this.operations.push({ query, values });
    const failure = this.failExecute?.(query, values);
    if (failure) throw failure;
    return { rowsAffected: 1 };
  }
  async select<T>(query: string, values: unknown[] = []): Promise<T> {
    this.operations.push({ query, values });
    return (this.results.shift() ?? []) as T;
  }
}

const result: ExecuteResult = {
  succeeded: true,
  cancelled: false,
  output: "ok",
  runRecord: {
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    runId: "run-new",
    flowId: "chat",
    flowVersion: "1.0.0",
    flowArtifactHash: "hash",
    status: "succeeded",
    input: "hello",
    output: "ok",
    createdAt: "2026-07-21T00:00:00.000Z",
    finishedAt: "2026-07-21T00:00:01.000Z",
  },
};

describe("Worker Runtime durable history", () => {
  it("publishes the terminal record only after every event row is durable", async () => {
    const database = new ScriptedDatabase();
    const history = new TauriWorkerRuntimeHistory(database);
    await history.save(result, [{
      eventId: "run-new:000001",
      runId: "run-new",
      flowId: "chat",
      flowVersion: "1.0.0",
      seq: 1,
      timestamp: "2026-07-21T00:00:00.000Z",
      kind: "run_started",
      payload: { input: "hello" },
    }]);
    const runWrite = database.operations.findIndex((item) => item.query.includes("INSERT INTO runtime_runs"));
    const deleteWrite = database.operations.findIndex((item) => item.query.includes("DELETE FROM runtime_events"));
    const eventWrite = database.operations.findIndex((item) => item.query.includes("INSERT INTO runtime_events"));
    const finalWrite = database.operations.findIndex((item) => item.query.includes("UPDATE runtime_runs"));
    expect(runWrite).toBeGreaterThanOrEqual(0);
    expect(deleteWrite).toBeGreaterThan(runWrite);
    expect(eventWrite).toBeGreaterThan(deleteWrite);
    expect(finalWrite).toBeGreaterThan(eventWrite);
    expect(database.operations[runWrite]?.values[2]).toBe("running");
    expect(JSON.parse(String(database.operations[runWrite]?.values[4]))).toEqual({
      ...result.runRecord,
      status: "running",
      output: undefined,
      finishedAt: undefined,
    });
    expect(database.operations[finalWrite]?.values[2]).toBe("succeeded");
    expect(JSON.parse(String(database.operations[finalWrite]?.values[4])))
      .toEqual(result.runRecord);
    expect(database.operations[eventWrite]?.values.at(-1)).toBe(JSON.stringify({ input: "hello" }));
  });

  it("leaves the staging run non-terminal when an event batch fails", async () => {
    const database = new ScriptedDatabase();
    database.failExecute = (query) => query.includes("INSERT INTO runtime_events")
      ? new Error("disk full")
      : undefined;
    const history = new TauriWorkerRuntimeHistory(database);

    await expect(history.save(result, [{
      eventId: "run-new:000001",
      runId: "run-new",
      flowId: "chat",
      flowVersion: "1.0.0",
      seq: 1,
      timestamp: "2026-07-21T00:00:00.000Z",
      kind: "run_started",
      payload: { input: "hello" },
    }])).rejects.toThrow("disk full");

    const runWrites = database.operations.filter((item) =>
      item.query.includes("runtime_runs"));
    expect(runWrites).toHaveLength(1);
    expect(runWrites[0]?.query).toContain("INSERT INTO runtime_runs");
    expect(runWrites[0]?.values[2]).toBe("running");
    expect(JSON.parse(String(runWrites[0]?.values[4]))).not.toHaveProperty("output");
    expect(database.operations.some((item) => item.query.includes("UPDATE runtime_runs")))
      .toBe(false);
  });

  it("compacts only adjacent canonical text and thinking deltas before batch insertion", async () => {
    const database = new ScriptedDatabase();
    const history = new TauriWorkerRuntimeHistory(database);
    const base = {
      runId: "run-new",
      flowId: "chat",
      flowVersion: "1.0.0",
      nodeId: "chat_model",
      nodeVersion: "1",
      attempt: 1,
      portId: "answer",
      streamId: "stream-1",
    } as const;

    await history.save(result, [
      event(1, "stream_open", { contentType: "text/markdown" }, base),
      event(2, "stream_delta", { text: "你" }, base),
      event(3, "stream_delta", { text: "好" }, base),
      event(4, "stream_delta", { text: "呀" }, base),
      event(5, "stream_artifact", { kind: "thinking_delta", text: "先分析" }, base),
      event(6, "stream_artifact", { kind: "thinking_delta", text: "再回答" }, base),
      event(7, "stream_artifact", { kind: "thinking_delta", text: "并复核" }, base),
      event(8, "stream_delta", { text: "！", metadata: "keep separate" }, base),
      event(9, "stream_close", { status: "ok" }, base),
    ]);

    const [eventBatch] = database.operations.filter((item) =>
      item.query.includes("INSERT INTO runtime_events"));
    expect(eventBatch).toBeDefined();
    const rows = chunk(eventBatch!.values, 15);
    expect(rows.map((row) => row[9])).toEqual([
      "stream_open",
      "stream_delta",
      "stream_artifact",
      "stream_delta",
      "stream_close",
    ]);
    expect(rows.map((row) => JSON.parse(String(row[14])))).toEqual([
      { contentType: "text/markdown" },
      { text: "你好呀" },
      { kind: "thinking_delta", text: "先分析再回答并复核" },
      { text: "！", metadata: "keep separate" },
      { status: "ok" },
    ]);
  });

  it("deletes age/count/quota candidates using the shared retention planner", async () => {
    const database = new ScriptedDatabase();
    database.results.push([
      { run_id: "new", created_at: "2026-07-21T00:00:00.000Z", status: "succeeded", bytes: 600 },
      { run_id: "old", created_at: "2026-06-01T00:00:00.000Z", status: "failed", bytes: 600 },
    ]);
    const history = new TauriWorkerRuntimeHistory(
      database,
      { maxAgeMs: 30 * 86_400_000, maxRuns: 10, maxBytes: 1_000 },
      () => Date.parse("2026-07-21T00:00:00.000Z"),
    );
    const gc = await history.prune();
    expect(gc).toEqual({
      scanned: 2,
      deleted: 1,
      retainedBytes: 600,
      deletedRunIds: ["old"],
    });
    expect(database.operations.some((item) =>
      item.query.includes("DELETE FROM runtime_runs") && item.values[0] === "old"))
      .toBe(true);
  });
});

function event(
  seq: number,
  kind: "stream_open" | "stream_delta" | "stream_artifact" | "stream_close",
  payload: unknown,
  identity: Pick<import("@ai-native-flow/event-bus").NodeEvent,
    "runId" | "flowId" | "flowVersion" | "nodeId" | "nodeVersion" |
    "attempt" | "portId" | "streamId">,
): import("@ai-native-flow/event-bus").NodeEvent {
  return {
    eventId: `run-new:${String(seq).padStart(6, "0")}`,
    ...identity,
    seq,
    timestamp: `2026-07-21T00:00:00.${String(seq).padStart(3, "0")}Z`,
    kind,
    payload,
  };
}

function chunk(values: unknown[], size: number): unknown[][] {
  return Array.from(
    { length: Math.ceil(values.length / size) },
    (_, index) => values.slice(index * size, (index + 1) * size),
  );
}
