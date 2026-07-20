import {
  InMemoryEventBus,
  formatEventId,
  parseEventIdSeq,
  type AppendEventInput,
  type EventBus,
  type EventStore,
  type NodeEvent,
  type NodeEventKind,
} from "../../../nkg-ai-flow/packages/event-bus/src/index.js";
import {
  sha256HexPortable,
  type ArtifactStore,
  type FlowVersionRef,
  type RegistryStore,
  type RunRecord,
  type RunStatus,
  type RunStore,
} from "../../../nkg-ai-flow/packages/runtime/src/browser.js";
import {
  InMemoryVariableStore,
  type MutableVariableStore,
  type VariableEntry,
  type VariableMetadata,
  type VariableValue,
} from "../../../nkg-ai-flow/packages/variable-store/src/browser.js";

export interface SqliteRuntimeDatabase {
  execute(
    query: string,
    bindValues?: unknown[],
  ): Promise<{ rowsAffected: number; lastInsertId?: number }>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
}

export interface TauriSqliteRuntimePersistence {
  runStore: RunStore;
  registryStore: RegistryStore;
  artifactStore: ArtifactStore;
  eventStore: EventStore;
  eventBus: EventBus;
  variables: TauriSqliteVariableStore;
  flush(): Promise<void>;
}

export interface TauriSqliteRuntimePersistenceOptions {
  hashText?: (input: string) => Promise<string>;
}

/** Build the portable Runtime's durable local stores after migrations run. */
export async function createTauriSqliteRuntimePersistence(
  database: SqliteRuntimeDatabase,
  options: TauriSqliteRuntimePersistenceOptions = {},
): Promise<TauriSqliteRuntimePersistence> {
  const hashText = options.hashText ?? sha256HexPortable;
  const variables = await TauriSqliteVariableStore.load(database);
  const eventStore = new TauriSqliteEventStore(database, () => variables.flush());
  return {
    runStore: new TauriSqliteRunStore(database),
    registryStore: new TauriSqliteRegistryStore(database),
    artifactStore: new TauriSqliteArtifactStore(database, hashText),
    eventStore,
    eventBus: new InMemoryEventBus(eventStore),
    variables,
    flush: () => variables.flush(),
  };
}

/** Stable, redacted error: SQL text and bound values never cross this seam. */
export class RuntimePersistenceError extends Error {
  readonly code = "runtime.persistence_failed";

  constructor(operation: string) {
    super(`Runtime persistence operation failed: ${operation}`);
    this.name = "RuntimePersistenceError";
  }
}

interface RunRow {
  record_json: string;
}

export class TauriSqliteRunStore implements RunStore {
  constructor(private readonly database: SqliteRuntimeDatabase) {}

  async create(record: RunRecord): Promise<void> {
    try {
      await this.database.execute(
        `INSERT INTO runtime_runs (run_id, flow_id, status, created_at, record_json)
         VALUES ($1, $2, $3, $4, $5)`,
        [record.runId, record.flowId, record.status, record.createdAt, JSON.stringify(record)],
      );
    } catch {
      throw new RuntimePersistenceError("create run");
    }
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    try {
      const [row] = await this.database.select<RunRow[]>(
        "SELECT record_json FROM runtime_runs WHERE run_id = $1",
        [runId],
      );
      return row ? parseRunRecord(row.record_json, runId) : undefined;
    } catch (error: unknown) {
      if (error instanceof RuntimePersistenceError) throw error;
      throw new RuntimePersistenceError("read run");
    }
  }

  async update(
    runId: string,
    patch: Partial<RunRecord> & { status?: RunStatus },
  ): Promise<RunRecord> {
    const safePatch = { ...patch } as Record<string, unknown>;
    delete safePatch.runId;
    delete safePatch.schemaVersion;
    try {
      const values: unknown[] = [];
      let recordExpression = "record_json";
      for (const key of RUN_RECORD_PATCH_FIELDS) {
        const value = safePatch[key];
        if (value === undefined) continue;
        values.push(JSON.stringify(value));
        recordExpression = `json_set(${recordExpression}, '$.${key}', json($${values.length}))`;
      }
      const assignments = [`record_json = ${recordExpression}`];
      for (const [jsonKey, column] of [
        ["flowId", "flow_id"],
        ["status", "status"],
        ["createdAt", "created_at"],
      ] as const) {
        if (safePatch[jsonKey] === undefined) continue;
        values.push(safePatch[jsonKey]);
        assignments.push(`${column} = $${values.length}`);
      }
      values.push(runId);
      const result = await this.database.execute(
        `UPDATE runtime_runs
            SET ${assignments.join(", ")}
          WHERE run_id = $${values.length}`,
        values,
      );
      if (result.rowsAffected === 0) {
        throw new RuntimePersistenceError("update missing run");
      }
      const updated = await this.get(runId);
      if (!updated) throw new RuntimePersistenceError("read updated run");
      return updated;
    } catch (error: unknown) {
      if (error instanceof RuntimePersistenceError) throw error;
      throw new RuntimePersistenceError("update run");
    }
  }

  async listByFlow(
    flowId: string,
    options: { limit?: number } = {},
  ): Promise<RunRecord[]> {
    try {
      const rows = await this.database.select<RunRow[]>(
        `SELECT record_json FROM runtime_runs
          WHERE flow_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [flowId, normalizeLimit(options.limit)],
      );
      return rows.map((row) => parseRunRecord(row.record_json));
    } catch (error: unknown) {
      if (error instanceof RuntimePersistenceError) throw error;
      throw new RuntimePersistenceError("list runs");
    }
  }
}

const RUN_RECORD_PATCH_FIELDS = [
  "flowId",
  "flowVersion",
  "flowArtifactHash",
  "status",
  "input",
  "output",
  "error",
  "createdAt",
  "startedAt",
  "finishedAt",
  "traceId",
  "subflowDepth",
] as const;

interface RegistryRow {
  flow_id: string;
  version: string;
  artifact_hash: string;
  resolved_status: FlowVersionRef["status"];
  graph_json: string;
  registered_at: string;
}

interface PromotionRow {
  previous_version: string | null;
}

const REGISTRY_SELECT = `SELECT r.flow_id, r.version, r.artifact_hash,
       CASE
         WHEN a.active_version = r.version THEN 'active'
         WHEN a.previous_version = r.version THEN 'draining'
         ELSE r.status
       END AS resolved_status,
       r.graph_json, r.registered_at
  FROM runtime_flow_registry r
  LEFT JOIN runtime_flow_active a ON a.flow_id = r.flow_id`;

export class TauriSqliteRegistryStore implements RegistryStore {
  constructor(private readonly database: SqliteRuntimeDatabase) {}

  async put(ref: FlowVersionRef): Promise<void> {
    try {
      await this.database.execute(
        `INSERT INTO runtime_flow_registry
           (flow_id, version, artifact_hash, status, graph_json, registered_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(flow_id, version) DO UPDATE SET
           artifact_hash = excluded.artifact_hash,
           status = excluded.status,
           graph_json = excluded.graph_json,
           registered_at = excluded.registered_at`,
        [ref.flowId, ref.version, ref.artifactHash, ref.status,
          JSON.stringify(ref.graph), ref.registeredAt],
      );
    } catch {
      throw new RuntimePersistenceError("register flow version");
    }
  }

  async get(flowId: string, version: string): Promise<FlowVersionRef | undefined> {
    try {
      const [row] = await this.database.select<RegistryRow[]>(
        `${REGISTRY_SELECT} WHERE r.flow_id = $1 AND r.version = $2`,
        [flowId, version],
      );
      return row ? mapRegistryRow(row) : undefined;
    } catch (error: unknown) {
      if (error instanceof RuntimePersistenceError) throw error;
      throw new RuntimePersistenceError("read flow version");
    }
  }

  async list(flowId: string): Promise<FlowVersionRef[]> {
    try {
      const rows = await this.database.select<RegistryRow[]>(
        `${REGISTRY_SELECT} WHERE r.flow_id = $1 ORDER BY r.registered_at DESC`,
        [flowId],
      );
      return rows.map(mapRegistryRow);
    } catch (error: unknown) {
      if (error instanceof RuntimePersistenceError) throw error;
      throw new RuntimePersistenceError("list flow versions");
    }
  }

  async promote(flowId: string, version: string): Promise<FlowVersionRef | undefined> {
    if (!await this.get(flowId, version)) {
      throw new Error(`flow ${flowId}@${version} not registered`);
    }
    try {
      const [result] = await this.database.select<PromotionRow[]>(
        `INSERT INTO runtime_flow_active
           (flow_id, active_version, previous_version, updated_at)
         VALUES ($1, $2, NULL, $3)
         ON CONFLICT(flow_id) DO UPDATE SET
           previous_version = CASE
             WHEN runtime_flow_active.active_version <> excluded.active_version
             THEN runtime_flow_active.active_version ELSE NULL END,
           active_version = excluded.active_version,
           updated_at = excluded.updated_at
         RETURNING previous_version`,
        [flowId, version, new Date().toISOString()],
      );
      if (!result) throw new RuntimePersistenceError("promote flow version");
      const previousVersion = result.previous_version;
      return previousVersion ? await this.get(flowId, previousVersion) : undefined;
    } catch (error: unknown) {
      if (error instanceof RuntimePersistenceError) throw error;
      throw new RuntimePersistenceError("promote flow version");
    }
  }

  async active(flowId: string): Promise<FlowVersionRef | undefined> {
    try {
      const [row] = await this.database.select<RegistryRow[]>(
        `${REGISTRY_SELECT}
          INNER JOIN runtime_flow_active current
            ON current.flow_id = r.flow_id AND current.active_version = r.version
         WHERE r.flow_id = $1`,
        [flowId],
      );
      return row ? mapRegistryRow(row) : undefined;
    } catch (error: unknown) {
      if (error instanceof RuntimePersistenceError) throw error;
      throw new RuntimePersistenceError("read active flow version");
    }
  }
}

interface ArtifactRow {
  artifact_hash: string;
  content_json: string;
}

export class TauriSqliteArtifactStore implements ArtifactStore {
  constructor(
    private readonly database: SqliteRuntimeDatabase,
    private readonly hashText: (input: string) => Promise<string> = sha256HexPortable,
  ) {}

  async putFlow(
    flowId: string,
    version: string,
    json: string,
  ): Promise<{ path: string; hash: string }> {
    const hash = await this.hashText(json);
    try {
      await this.database.execute(
        `INSERT INTO runtime_flow_artifacts
           (flow_id, version, artifact_hash, content_json, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(flow_id, version) DO UPDATE SET
           artifact_hash = excluded.artifact_hash,
           content_json = excluded.content_json,
           created_at = excluded.created_at`,
        [flowId, version, hash, json, new Date().toISOString()],
      );
      return {
        path: `sqlite://runtime-flow-artifacts/${encodeURIComponent(flowId)}/${encodeURIComponent(version)}`,
        hash,
      };
    } catch {
      throw new RuntimePersistenceError("write flow artifact");
    }
  }

  async getFlowJson(
    flowId: string,
    version: string,
    expectedHash?: string,
  ): Promise<string> {
    try {
      const [row] = await this.database.select<ArtifactRow[]>(
        `SELECT artifact_hash, content_json FROM runtime_flow_artifacts
          WHERE flow_id = $1 AND version = $2`,
        [flowId, version],
      );
      if (!row) throw new Error("artifact not found");
      const actualHash = await this.hashText(row.content_json);
      if (actualHash !== row.artifact_hash || (expectedHash && actualHash !== expectedHash)) {
        throw new Error("artifact hash mismatch");
      }
      return row.content_json;
    } catch {
      throw new RuntimePersistenceError("read flow artifact");
    }
  }
}

interface EventSequenceRow { event_sequence: number; }
interface EventRow {
  run_id: string;
  event_sequence: number;
  flow_id: string;
  flow_version: string;
  node_id: string | null;
  node_version: string | null;
  attempt: number | null;
  node_sequence: number;
  timestamp: string;
  kind: NodeEventKind;
  port_id: string | null;
  stream_id: string | null;
  trace_id: string | null;
  parent_event_id: string | null;
  payload_json: string;
}

export class TauriSqliteEventStore implements EventStore {
  constructor(
    private readonly database: SqliteRuntimeDatabase,
    private readonly beforeAppend: () => Promise<void> = async () => undefined,
  ) {}

  async append(event: AppendEventInput): Promise<NodeEvent> {
    await this.beforeAppend();
    const timestamp = event.timestamp ?? new Date().toISOString();
    try {
      const [row] = await this.database.select<EventSequenceRow[]>(
        `INSERT INTO runtime_events
           (run_id, event_sequence, flow_id, flow_version, node_id, node_version,
            attempt, node_sequence, timestamp, kind, port_id, stream_id, trace_id,
            parent_event_id, payload_json)
         SELECT $1, COALESCE(MAX(event_sequence), 0) + 1, $2, $3, $4, $5,
                $6, $7, $8, $9, $10, $11, $12, $13, $14
           FROM runtime_events WHERE run_id = $1
         RETURNING event_sequence`,
        [event.runId, event.flowId, event.flowVersion, event.nodeId ?? null,
          event.nodeVersion ?? null, event.attempt ?? null, event.seq, timestamp,
          event.kind, event.portId ?? null, event.streamId ?? null,
          event.traceId ?? null, event.parentEventId ?? null,
          JSON.stringify(event.payload ?? null)],
      );
      if (!row) throw new RuntimePersistenceError("append runtime event");
      return { ...event, eventId: formatEventId(event.runId, row.event_sequence), timestamp };
    } catch (error: unknown) {
      if (error instanceof RuntimePersistenceError) throw error;
      throw new RuntimePersistenceError("append runtime event");
    }
  }

  async read(
    runId: string,
    options: { sinceEventId?: string; limit?: number } = {},
  ): Promise<NodeEvent[]> {
    try {
      let sinceSequence = 0;
      if (options.sinceEventId) {
        if (!options.sinceEventId.startsWith(`${runId}:`)) return [];
        sinceSequence = parseEventIdSeq(options.sinceEventId);
        if (!Number.isFinite(sinceSequence)) return [];
        const [cursor] = await this.database.select<EventSequenceRow[]>(
          `SELECT event_sequence FROM runtime_events
            WHERE run_id = $1 AND event_sequence = $2`,
          [runId, sinceSequence],
        );
        if (!cursor) return [];
      }
      const rows = await this.database.select<EventRow[]>(
        `SELECT run_id, event_sequence, flow_id, flow_version, node_id, node_version,
                attempt, node_sequence, timestamp, kind, port_id, stream_id,
                trace_id, parent_event_id, payload_json
           FROM runtime_events
          WHERE run_id = $1 AND event_sequence > $2
          ORDER BY event_sequence ASC LIMIT $3`,
        [runId, sinceSequence, normalizeLimit(options.limit)],
      );
      return rows.map(mapEventRow);
    } catch {
      throw new RuntimePersistenceError("read runtime events");
    }
  }

  async size(runId: string): Promise<number> {
    try {
      const [row] = await this.database.select<Array<{ event_count: number }>>(
        "SELECT COUNT(*) AS event_count FROM runtime_events WHERE run_id = $1",
        [runId],
      );
      return row?.event_count ?? 0;
    } catch {
      throw new RuntimePersistenceError("count runtime events");
    }
  }
}

interface VariableRow {
  name: string;
  value_json: string;
  metadata_json: string | null;
}

/**
 * Synchronous cache with an ordered SQLite write-through queue. Event append
 * flushes the queue before persisting node completion, making checkpoints
 * durable before they are observable as completed.
 */
export class TauriSqliteVariableStore implements MutableVariableStore {
  private pending: Promise<void> = Promise.resolve();
  private writeFailure = false;

  private constructor(
    private readonly database: SqliteRuntimeDatabase,
    private readonly memory: InMemoryVariableStore,
  ) {}

  static async load(database: SqliteRuntimeDatabase): Promise<TauriSqliteVariableStore> {
    try {
      const rows = await database.select<VariableRow[]>(
        "SELECT name, value_json, metadata_json FROM runtime_variables ORDER BY name",
      );
      const entries: VariableEntry[] = rows.map((row) => ({
        name: row.name,
        value: parseVariableValue(row.value_json),
        ...(row.metadata_json ? { metadata: parseVariableMetadata(row.metadata_json) } : {}),
      }));
      return new TauriSqliteVariableStore(database, new InMemoryVariableStore(entries));
    } catch (error: unknown) {
      if (error instanceof RuntimePersistenceError) throw error;
      throw new RuntimePersistenceError("load runtime variables");
    }
  }

  get(name: string): VariableValue | undefined { return this.memory.get(name); }
  getRequired(name: string): VariableValue { return this.memory.getRequired(name); }
  getString(name: string): string | undefined { return this.memory.getString(name); }
  getNumber(name: string): number | undefined { return this.memory.getNumber(name); }
  getBoolean(name: string): boolean | undefined { return this.memory.getBoolean(name); }
  has(name: string): boolean { return this.memory.has(name); }
  list(): readonly VariableEntry[] { return this.memory.list(); }
  describe(name: string): VariableEntry | undefined { return this.memory.describe(name); }

  set(name: string, value: VariableValue, metadata?: VariableMetadata): void {
    if (isSensitiveVariableName(name) || metadata?.source === "secret") {
      throw new RuntimePersistenceError("reject sensitive runtime variable");
    }
    this.memory.set(name, value, metadata);
    const entry = this.memory.describe(name)!;
    this.enqueue(async () => {
      await this.database.execute(
        `INSERT INTO runtime_variables (name, value_json, metadata_json, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(name) DO UPDATE SET
           value_json = excluded.value_json,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
        [entry.name, JSON.stringify(entry.value),
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          entry.metadata?.updatedAt ?? new Date().toISOString()],
      );
    });
  }

  delete(name: string): boolean {
    const deleted = this.memory.delete(name);
    if (deleted) {
      this.enqueue(async () => {
        await this.database.execute("DELETE FROM runtime_variables WHERE name = $1", [name]);
      });
    }
    return deleted;
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.writeFailure) throw new RuntimePersistenceError("flush runtime variables");
  }

  private enqueue(write: () => Promise<void>): void {
    this.pending = this.pending.then(write).catch(() => { this.writeFailure = true; });
  }
}

function parseRunRecord(json: string, expectedRunId?: string): RunRecord {
  const parsed = parseJsonObject(json, "run record") as unknown as RunRecord;
  if (typeof parsed.runId !== "string" || typeof parsed.flowId !== "string" ||
      typeof parsed.createdAt !== "string" ||
      (expectedRunId !== undefined && parsed.runId !== expectedRunId)) {
    throw new RuntimePersistenceError("decode run record");
  }
  return parsed;
}

function mapRegistryRow(row: RegistryRow): FlowVersionRef {
  return {
    flowId: row.flow_id,
    version: row.version,
    artifactHash: row.artifact_hash,
    status: row.resolved_status,
    graph: parseJsonObject(row.graph_json, "flow graph") as unknown as FlowVersionRef["graph"],
    registeredAt: row.registered_at,
  };
}

function mapEventRow(row: EventRow): NodeEvent {
  return {
    eventId: formatEventId(row.run_id, row.event_sequence),
    runId: row.run_id,
    flowId: row.flow_id,
    flowVersion: row.flow_version,
    ...(row.node_id !== null ? { nodeId: row.node_id } : {}),
    ...(row.node_version !== null ? { nodeVersion: row.node_version } : {}),
    ...(row.attempt !== null ? { attempt: row.attempt } : {}),
    seq: row.node_sequence,
    timestamp: row.timestamp,
    kind: row.kind,
    ...(row.port_id !== null ? { portId: row.port_id } : {}),
    ...(row.stream_id !== null ? { streamId: row.stream_id } : {}),
    ...(row.trace_id !== null ? { traceId: row.trace_id } : {}),
    ...(row.parent_event_id !== null ? { parentEventId: row.parent_event_id } : {}),
    payload: parseJson(row.payload_json, "event payload"),
  };
}

function parseVariableValue(json: string): VariableValue {
  return parseJson(json, "runtime variable") as VariableValue;
}

function parseVariableMetadata(json: string): VariableMetadata {
  return parseJsonObject(json, "runtime variable metadata") as VariableMetadata;
}

function parseJson(json: string, label: string): unknown {
  try { return JSON.parse(json) as unknown; }
  catch { throw new RuntimePersistenceError(`decode ${label}`); }
}

function parseJsonObject(json: string, label: string): Record<string, unknown> {
  const parsed = parseJson(json, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RuntimePersistenceError(`decode ${label}`);
  }
  return parsed as Record<string, unknown>;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 2_147_483_647;
  if (!Number.isFinite(limit) || limit <= 0) return 1;
  return Math.min(Math.trunc(limit), 10_000);
}

function isSensitiveVariableName(name: string): boolean {
  return /(^|[_:.-])(api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)($|[_:.-])/i
    .test(name);
}
