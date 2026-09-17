import type { NodeEvent } from "@ai-native-flow/event-bus";
import {
  DEFAULT_RUN_RETENTION_POLICY,
  planRunRetention,
  type RunRetentionPolicy,
} from "@ai-native-flow/runtime/retention";
import type { ExecuteResult, RunRecord } from "@ai-native-flow/runtime";
import type { SqliteRuntimeDatabase } from "./sqliteRuntimePersistence.js";

export interface WorkerRuntimeHistory {
  save(result: ExecuteResult, events: readonly NodeEvent[]): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  getEvents(runId: string, cursor?: string, limit?: number): Promise<NodeEvent[]>;
  prune(): Promise<RuntimeGcResult>;
}

export interface RuntimeGcResult {
  scanned: number;
  deleted: number;
  retainedBytes: number;
  deletedRunIds: string[];
}

interface RetentionRow {
  run_id: string;
  created_at: string;
  status: RunRecord["status"];
  bytes: number;
}

interface JsonRow { record_json: string }
interface EventJsonRow { event_json: string }

const EVENT_INSERT_BATCH_SIZE = 100;
const EVENT_COLUMNS_PER_ROW = 15;

export class TauriWorkerRuntimeHistory implements WorkerRuntimeHistory {
  constructor(
    private readonly database: SqliteRuntimeDatabase,
    private readonly policy: RunRetentionPolicy = DEFAULT_RUN_RETENTION_POLICY,
    private readonly now: () => number = Date.now,
  ) {}

  async save(result: ExecuteResult, events: readonly NodeEvent[]): Promise<void> {
    const record = result.runRecord;
    const runningRecord = createRunningRecord(record);

    // Publish a non-terminal staging record before replacing the durable event
    // set. If the process exits (or a later write rejects), readers can observe
    // an interrupted run, but never a terminal success backed by an event
    // prefix.
    await this.database.execute(
      `INSERT INTO runtime_runs (run_id, flow_id, status, created_at, record_json)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(run_id) DO UPDATE SET
         flow_id=excluded.flow_id, status=excluded.status,
         created_at=excluded.created_at, record_json=excluded.record_json`,
      [runningRecord.runId, runningRecord.flowId, runningRecord.status,
        runningRecord.createdAt, JSON.stringify(runningRecord)],
    );
    await this.database.execute("DELETE FROM runtime_events WHERE run_id = $1", [record.runId]);

    const durableEvents = compactDurableStreamEvents(events);
    for (let offset = 0; offset < durableEvents.length; offset += EVENT_INSERT_BATCH_SIZE) {
      const batch = durableEvents.slice(offset, offset + EVENT_INSERT_BATCH_SIZE);
      await this.database.execute(
        `INSERT INTO runtime_events
           (run_id, event_sequence, flow_id, flow_version, node_id, node_version,
            attempt, node_sequence, timestamp, kind, port_id, stream_id, trace_id,
            parent_event_id, payload_json)
         VALUES ${createEventValuePlaceholders(batch.length)}`,
        batch.flatMap((event, batchIndex) => eventInsertValues(event, offset + batchIndex + 1)),
      );
    }

    // The terminal state is the commit marker for this application-level
    // write protocol. It is deliberately last, after every event batch.
    const finalWrite = await this.database.execute(
      `UPDATE runtime_runs
          SET flow_id = $2, status = $3, created_at = $4, record_json = $5
        WHERE run_id = $1`,
      [record.runId, record.flowId, record.status, record.createdAt, JSON.stringify(record)],
    );
    if (finalWrite.rowsAffected === 0) {
      throw new Error("Runtime history staging record disappeared before finalization");
    }
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const [row] = await this.database.select<JsonRow[]>(
      "SELECT record_json FROM runtime_runs WHERE run_id = $1",
      [runId],
    );
    return row ? JSON.parse(row.record_json) as RunRecord : undefined;
  }

  async getEvents(runId: string, cursor?: string, limit = 1_000): Promise<NodeEvent[]> {
    const cursorSequence = cursor?.startsWith(`${runId}:`)
      ? Number.parseInt(cursor.slice(cursor.lastIndexOf(":") + 1), 10)
      : 0;
    const rows = await this.database.select<EventJsonRow[]>(
      `SELECT json_object(
         'eventId', run_id || ':' || printf('%06d', event_sequence),
         'runId', run_id, 'flowId', flow_id, 'flowVersion', flow_version,
         'nodeId', node_id, 'nodeVersion', node_version, 'attempt', attempt,
         'seq', node_sequence, 'timestamp', timestamp, 'kind', kind,
         'portId', port_id, 'streamId', stream_id, 'traceId', trace_id,
         'parentEventId', parent_event_id, 'payload', json(payload_json)
       ) AS event_json
       FROM runtime_events
       WHERE run_id = $1 AND event_sequence > $2
       ORDER BY event_sequence ASC LIMIT $3`,
      [runId, Number.isFinite(cursorSequence) ? cursorSequence : 0, normalizeLimit(limit)],
    );
    return rows.map((row) => compactEvent(JSON.parse(row.event_json) as NodeEvent));
  }

  async prune(): Promise<RuntimeGcResult> {
    const rows = await this.database.select<RetentionRow[]>(
      `SELECT r.run_id, r.created_at, r.status,
              length(CAST(r.record_json AS BLOB))
                + COALESCE(SUM(length(CAST(e.payload_json AS BLOB))), 0) AS bytes
       FROM runtime_runs r
       LEFT JOIN runtime_events e ON e.run_id = r.run_id
       GROUP BY r.run_id, r.created_at, r.status, r.record_json
       ORDER BY r.created_at DESC`,
    );
    const plan = planRunRetention(rows.map((row) => ({
      runId: row.run_id,
      createdAt: row.created_at,
      status: row.status,
      bytes: Number(row.bytes),
    })), this.policy, this.now());
    for (const decision of plan.delete) {
      await this.database.execute("DELETE FROM runtime_runs WHERE run_id = $1", [decision.runId]);
    }
    return {
      scanned: rows.length,
      deleted: plan.delete.length,
      retainedBytes: plan.retainedBytes,
      deletedRunIds: plan.delete.map((item) => item.runId),
    };
  }
}

function normalizeLimit(value: number): number {
  return Math.max(1, Math.min(10_000, Math.trunc(value)));
}

function compactEvent(event: NodeEvent): NodeEvent {
  return Object.fromEntries(
    Object.entries(event).filter(([, value]) => value !== null),
  ) as unknown as NodeEvent;
}

function createRunningRecord(record: RunRecord): RunRecord {
  const { output: _output, error: _error, finishedAt: _finishedAt, ...inProgress } = record;
  return { ...inProgress, status: "running" };
}

function createEventValuePlaceholders(rowCount: number): string {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const first = rowIndex * EVENT_COLUMNS_PER_ROW + 1;
    return `(${Array.from(
      { length: EVENT_COLUMNS_PER_ROW },
      (__, columnIndex) => `$${first + columnIndex}`,
    ).join(", ")})`;
  }).join(", ");
}

function eventInsertValues(event: NodeEvent, eventSequence: number): unknown[] {
  return [
    event.runId,
    eventSequence,
    event.flowId,
    event.flowVersion,
    event.nodeId ?? null,
    event.nodeVersion ?? null,
    event.attempt ?? null,
    event.seq,
    event.timestamp,
    event.kind,
    event.portId ?? null,
    event.streamId ?? null,
    event.traceId ?? null,
    event.parentEventId ?? null,
    JSON.stringify(event.payload ?? null),
  ];
}

/**
 * Reduce durable-write volume without changing the live event stream. Only
 * adjacent, consecutive deltas with identical stream identity and canonical
 * payload shapes are merged; arbitrary artifacts and enriched payloads remain
 * byte-for-byte separate events.
 */
function compactDurableStreamEvents(events: readonly NodeEvent[]): NodeEvent[] {
  const compacted: NodeEvent[] = [];
  for (const event of events) {
    const previous = compacted.at(-1);
    const mergedPayload = previous ? mergeableStreamPayload(previous, event) : undefined;
    if (previous && mergedPayload !== undefined) {
      // Retain the latest cursor metadata so a run of more than two
      // consecutive deltas can continue coalescing.
      compacted[compacted.length - 1] = { ...event, payload: mergedPayload };
    } else {
      compacted.push(event);
    }
  }
  return compacted;
}

function mergeableStreamPayload(
  previous: NodeEvent,
  current: NodeEvent,
): Record<string, unknown> | undefined {
  if (!hasSameStreamIdentity(previous, current) || current.seq !== previous.seq + 1) {
    return undefined;
  }
  const previousPayload = asRecord(previous.payload);
  const currentPayload = asRecord(current.payload);
  if (!previousPayload || !currentPayload) return undefined;

  if (previous.kind === "stream_delta") {
    for (const field of ["text", "delta"] as const) {
      if (hasExactKeys(previousPayload, [field]) && hasExactKeys(currentPayload, [field]) &&
          typeof previousPayload[field] === "string" && typeof currentPayload[field] === "string") {
        return { [field]: previousPayload[field] + currentPayload[field] };
      }
    }
    return undefined;
  }

  if (previous.kind === "stream_artifact" &&
      hasExactKeys(previousPayload, ["kind", "text"]) &&
      hasExactKeys(currentPayload, ["kind", "text"]) &&
      previousPayload.kind === "thinking_delta" && currentPayload.kind === "thinking_delta" &&
      typeof previousPayload.text === "string" && typeof currentPayload.text === "string") {
    return { kind: "thinking_delta", text: previousPayload.text + currentPayload.text };
  }
  return undefined;
}

function hasSameStreamIdentity(previous: NodeEvent, current: NodeEvent): boolean {
  return previous.kind === current.kind &&
    previous.runId === current.runId &&
    previous.flowId === current.flowId &&
    previous.flowVersion === current.flowVersion &&
    previous.nodeId === current.nodeId &&
    previous.nodeVersion === current.nodeVersion &&
    previous.attempt === current.attempt &&
    previous.portId === current.portId &&
    previous.streamId === current.streamId &&
    previous.traceId === current.traceId &&
    previous.parentEventId === current.parentEventId;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}
