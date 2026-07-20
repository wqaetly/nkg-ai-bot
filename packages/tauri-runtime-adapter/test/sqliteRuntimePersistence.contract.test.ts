import { describe, expect, it } from "vitest";
import { RUN_RECORD_SCHEMA_VERSION, type FlowVersionRef, type RunRecord } from "../../../nkg-ai-flow/packages/runtime/src/browser.js";
import {
  RuntimePersistenceError,
  TauriSqliteArtifactStore,
  TauriSqliteRegistryStore,
  TauriSqliteRunStore,
  createTauriSqliteRuntimePersistence,
  type SqliteRuntimeDatabase,
} from "../src/sqliteRuntimePersistence.js";

class ScriptedDatabase implements SqliteRuntimeDatabase {
  readonly operations: Array<{ kind: "execute" | "select"; query: string; values: unknown[] }> = [];
  readonly selectResults: unknown[] = [];
  readonly executeResults: Array<{ rowsAffected: number; lastInsertId?: number }> = [];
  executeError: Error | undefined;

  async execute(query: string, bindValues: unknown[] = []) {
    this.operations.push({ kind: "execute", query, values: bindValues });
    if (this.executeError) throw this.executeError;
    return this.executeResults.shift() ?? { rowsAffected: 1 };
  }

  async select<T>(query: string, bindValues: unknown[] = []): Promise<T> {
    this.operations.push({ kind: "select", query, values: bindValues });
    return (this.selectResults.shift() ?? []) as T;
  }
}

const record: RunRecord = {
  schemaVersion: RUN_RECORD_SCHEMA_VERSION,
  runId: "run-1",
  flowId: "chat",
  flowVersion: "1.0.0",
  flowArtifactHash: "hash-1",
  status: "queued",
  input: { text: "hello" },
  createdAt: "2026-07-20T00:00:00.000Z",
};

function registryRow(version: string, status: FlowVersionRef["status"] = "staging") {
  return {
    flow_id: "chat",
    version,
    artifact_hash: `hash-${version}`,
    resolved_status: status,
    graph_json: JSON.stringify({ id: "chat", version, nodes: [], edges: [] }),
    registered_at: "2026-07-20T00:00:00.000Z",
  };
}

describe("Tauri SQLite Runtime persistence contracts", () => {
  it("persists complete RunRecords and protects immutable identity fields during patching", async () => {
    const database = new ScriptedDatabase();
    const store = new TauriSqliteRunStore(database);
    await store.create(record);

    database.selectResults.push([{ record_json: JSON.stringify(record) }]);
    expect(await store.get(record.runId)).toEqual(record);

    const succeeded = { ...record, status: "succeeded", output: "ok" } satisfies RunRecord;
    database.selectResults.push([{ record_json: JSON.stringify(succeeded) }]);
    const updated = await store.update(record.runId, {
      status: "succeeded",
      output: "ok",
      runId: "must-not-replace",
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    });

    expect(updated).toEqual(succeeded);
    const update = database.operations.find((operation) => operation.query.includes("json_set"));
    expect(update?.query).not.toContain("must-not-replace");
    expect(update?.values).toEqual([
      JSON.stringify("succeeded"),
      JSON.stringify("ok"),
      "succeeded",
      record.runId,
    ]);
  });

  it("moves the active Registry pointer in one returning statement", async () => {
    const database = new ScriptedDatabase();
    const store = new TauriSqliteRegistryStore(database);
    database.selectResults.push(
      [registryRow("2.0.0")],
      [{ previous_version: "1.0.0" }],
      [registryRow("1.0.0", "draining")],
    );

    const previous = await store.promote("chat", "2.0.0");

    expect(previous?.version).toBe("1.0.0");
    const pointerWrite = database.operations.find((operation) =>
      operation.query.includes("INSERT INTO runtime_flow_active"));
    expect(pointerWrite?.kind).toBe("select");
    expect(pointerWrite?.query).toContain("RETURNING previous_version");
  });

  it("verifies artifact contents against both stored and expected hashes", async () => {
    const database = new ScriptedDatabase();
    const hashText = async (value: string) => `hash:${value}`;
    const store = new TauriSqliteArtifactStore(database, hashText);
    const json = JSON.stringify({ id: "chat", version: "1.0.0" });

    const saved = await store.putFlow("chat", "1.0.0", json);
    database.selectResults.push([{ artifact_hash: saved.hash, content_json: json }]);

    expect(await store.getFlowJson("chat", "1.0.0", saved.hash)).toBe(json);
  });

  it("flushes checkpoint writes before a node event becomes durable", async () => {
    const database = new ScriptedDatabase();
    database.selectResults.push([], [{ event_sequence: 1 }]);
    const persistence = await createTauriSqliteRuntimePersistence(database, {
      hashText: async () => "hash",
    });

    persistence.variables.set("checkpoint:order", { version: 1 }, { source: "runtime" });
    await persistence.eventBus.publish({
      runId: "run-1",
      flowId: "chat",
      flowVersion: "1.0.0",
      nodeId: "checkpoint",
      nodeVersion: "1.0.0",
      attempt: 1,
      seq: 2,
      kind: "node_finished",
      payload: { output: { saved: true } },
    });

    const variableWrite = database.operations.findIndex((operation) =>
      operation.query.includes("INSERT INTO runtime_variables"));
    const eventWrite = database.operations.findIndex((operation) =>
      operation.query.includes("INSERT INTO runtime_events"));
    expect(variableWrite).toBeGreaterThan(-1);
    expect(eventWrite).toBeGreaterThan(variableWrite);
  });

  it("rehydrates durable checkpoint state when a portable Runtime restarts", async () => {
    const database = new ScriptedDatabase();
    database.selectResults.push([{
      name: "checkpoint:order",
      value_json: JSON.stringify({ version: 3, snapshot: { step: "paid" } }),
      metadata_json: JSON.stringify({ source: "runtime", scope: { flowId: "order" } }),
    }]);

    const persistence = await createTauriSqliteRuntimePersistence(database);

    expect(persistence.variables.get("checkpoint:order")).toEqual({
      version: 3,
      snapshot: { step: "paid" },
    });
    expect(persistence.variables.describe("checkpoint:order")?.metadata?.scope?.flowId)
      .toBe("order");
  });

  it("rejects API keys before they can enter ordinary SQLite variables", async () => {
    const database = new ScriptedDatabase();
    database.selectResults.push([]);
    const persistence = await createTauriSqliteRuntimePersistence(database);

    expect(() => persistence.variables.set("LLM_API_KEY", "sk-user-value"))
      .toThrow(RuntimePersistenceError);
    expect(database.operations.some((operation) =>
      operation.values.includes("sk-user-value"))).toBe(false);
  });

  it("redacts SQL and bound values from persistence failures", async () => {
    const database = new ScriptedDatabase();
    database.executeError = new Error("INSERT secret sk-user-value");
    const store = new TauriSqliteRunStore(database);

    const failure = await store.create(record).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimePersistenceError);
    expect(String(failure)).not.toContain("INSERT");
    expect(String(failure)).not.toContain("sk-user-value");
  });
});
