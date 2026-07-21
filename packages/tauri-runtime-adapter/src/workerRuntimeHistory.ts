import type { NodeEvent } from "@ai-native-flow/event-bus";
import {
  DEFAULT_RUN_RETENTION_POLICY,
  planRunRetention,
  type ExecuteResult,
  type RunRecord,
  type RunRetentionPolicy,
} from "@ai-native-flow/runtime";
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

export class TauriWorkerRuntimeHistory implements WorkerRuntimeHistory {
  constructor(
    private readonly database: SqliteRuntimeDatabase,
    private readonly policy: RunRetentionPolicy = DEFAULT_RUN_RETENTION_POLICY,
    private readonly now: () => number = Date.now,
  ) {}

  async save(result: ExecuteResult, events: readonly NodeEvent[]): Promise<void> {
    const record = result.runRecord;
    await this.database.execute(
      `INSERT INTO runtime_runs (run_id, flow_id, status, created_at, record_json)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(run_id) DO UPDATE SET
         flow_id=excluded.flow_id, status=excluded.status,
         created_at=excluded.created_at, record_json=excluded.record_json`,
      [record.runId, record.flowId, record.status, record.createdAt, JSON.stringify(record)],
    );
    await this.database.execute("DELETE FROM runtime_events WHERE run_id = $1", [record.runId]);
    for (const [index, event] of events.entries()) {
      await this.database.execute(
        `INSERT INTO runtime_events
           (run_id, event_sequence, flow_id, flow_version, node_id, node_version,
            attempt, node_sequence, timestamp, kind, port_id, stream_id, trace_id,
            parent_event_id, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [event.runId, index + 1, event.flowId, event.flowVersion,
          event.nodeId ?? null, event.nodeVersion ?? null, event.attempt ?? null,
          event.seq, event.timestamp, event.kind, event.portId ?? null,
          event.streamId ?? null, event.traceId ?? null, event.parentEventId ?? null,
          JSON.stringify(event.payload ?? null)],
      );
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
