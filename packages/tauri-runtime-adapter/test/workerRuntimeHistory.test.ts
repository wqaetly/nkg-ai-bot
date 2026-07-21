import { describe, expect, it } from "vitest";
import { RUN_RECORD_SCHEMA_VERSION, type ExecuteResult } from "@ai-native-flow/runtime";
import {
  TauriWorkerRuntimeHistory,
  type SqliteRuntimeDatabase,
} from "../src/index.js";

class ScriptedDatabase implements SqliteRuntimeDatabase {
  readonly operations: Array<{ query: string; values: unknown[] }> = [];
  readonly results: unknown[] = [];
  async execute(query: string, values: unknown[] = []) {
    this.operations.push({ query, values });
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
  it("persists the terminal record before its event rows", async () => {
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
    const eventWrite = database.operations.findIndex((item) => item.query.includes("INSERT INTO runtime_events"));
    expect(runWrite).toBeGreaterThanOrEqual(0);
    expect(eventWrite).toBeGreaterThan(runWrite);
    expect(database.operations[eventWrite]?.values.at(-1)).toBe(JSON.stringify({ input: "hello" }));
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
