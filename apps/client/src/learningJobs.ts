import { getDatabase, type DatabaseClient } from "./storage/database";

export type LearningJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type LearningJobMode = "review" | "auto_archive";

export interface LearningJob {
  id: string;
  type: "reflection";
  sourceConversationId: string;
  sourceMessageId?: string;
  mode: LearningJobMode;
  memoryNamespace: string;
  status: LearningJobStatus;
  checkpoint: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string; code?: string };
  runtimeRunId?: string;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

type LearningJobRow = {
  id: string;
  type: "reflection";
  source_conversation_id: string;
  source_message_id: string | null;
  status: LearningJobStatus;
  checkpoint_json: string;
  result_json: string | null;
  error_json: string | null;
  runtime_run_id: string | null;
  attempt: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
};

export async function createReflectionJob(
  input: {
    sourceConversationId: string;
    sourceMessageId?: string;
    mode?: LearningJobMode;
    memoryNamespace?: string;
  },
  client?: DatabaseClient,
): Promise<LearningJob> {
  requireText(input.sourceConversationId, "Conversation id");
  const memoryNamespace = input.memoryNamespace?.trim() || "global";
  if (memoryNamespace.length > 120) throw new Error("Memory namespace is too long");
  const database = client ?? await getDatabase();
  const id = crypto.randomUUID();
  const now = Date.now();
  await database.execute(
    `INSERT INTO learning_jobs
       (id, type, source_conversation_id, source_message_id, status, checkpoint_json,
        created_at, updated_at)
     VALUES ($1, 'reflection', $2, $3, 'queued', $4, $5, $5)`,
    [
      id,
      input.sourceConversationId,
      input.sourceMessageId ?? null,
      JSON.stringify({
        phase: "queued",
        mode: input.mode ?? "review",
        memoryNamespace,
      }),
      now,
    ],
  );
  const job = await getLearningJob(id, database);
  if (!job) throw new Error("Learning job was not persisted");
  return job;
}

export async function getLearningJob(
  id: string,
  client?: DatabaseClient,
): Promise<LearningJob | undefined> {
  const database = client ?? await getDatabase();
  const [row] = await database.select<LearningJobRow[]>(
    "SELECT * FROM learning_jobs WHERE id=$1",
    [id],
  );
  return row ? mapLearningJob(row) : undefined;
}

export async function listLearningJobs(
  limit = 50,
  client?: DatabaseClient,
): Promise<LearningJob[]> {
  const database = client ?? await getDatabase();
  const rows = await database.select<LearningJobRow[]>(
    "SELECT * FROM learning_jobs ORDER BY created_at DESC LIMIT $1",
    [Math.min(Math.max(Math.trunc(limit), 1), 200)],
  );
  return rows.map(mapLearningJob);
}

/** Convert jobs abandoned by a terminated process into explicitly resumable work. */
export async function recoverInterruptedLearningJobs(client?: DatabaseClient): Promise<number> {
  const database = client ?? await getDatabase();
  const now = Date.now();
  const result = await database.execute(
    `UPDATE learning_jobs
        SET status='interrupted',
            checkpoint_json=json_remove(
              json_set(checkpoint_json, '$.phase', 'interrupted', '$.reason', 'process_restart'),
              '$.step', '$.runtimeRunId'
            ),
            runtime_run_id=NULL, error_json=$1, updated_at=$2, completed_at=NULL
      WHERE status='running'`,
    [
      JSON.stringify({ code: "learning.interrupted", message: "应用退出时任务仍在运行，可安全继续" }),
      now,
    ],
  );
  return result.rowsAffected;
}

export async function claimLearningJob(
  id: string,
  client?: DatabaseClient,
): Promise<LearningJob> {
  const database = client ?? await getDatabase();
  const now = Date.now();
  const result = await database.execute(
    `UPDATE learning_jobs
        SET status='running',
            checkpoint_json=json_remove(
              json_set(checkpoint_json, '$.phase', 'running', '$.step', 'building_evidence'),
              '$.reason', '$.runtimeRunId'
            ),
            error_json=NULL, result_json=NULL, runtime_run_id=NULL,
            attempt=attempt+1, started_at=$2, completed_at=NULL, updated_at=$2
      WHERE id=$1 AND status IN ('queued', 'interrupted')`,
    [id, now],
  );
  if (result.rowsAffected !== 1) throw new Error("Learning job is not resumable");
  const job = await getLearningJob(id, database);
  if (!job) throw new Error("Claimed learning job was not found");
  return job;
}

export async function updateLearningJobRun(
  id: string,
  runtimeRunId: string,
  client?: DatabaseClient,
): Promise<void> {
  const database = client ?? await getDatabase();
  await database.execute(
    `UPDATE learning_jobs
        SET runtime_run_id=$2,
            checkpoint_json=json_set(
              checkpoint_json, '$.phase', 'running', '$.step', 'reflection_flow', '$.runtimeRunId', $2
            ),
            updated_at=$3
      WHERE id=$1 AND status='running'`,
    [id, runtimeRunId, Date.now()],
  );
}

export async function completeLearningJob(
  id: string,
  result: Record<string, unknown>,
  client?: DatabaseClient,
): Promise<void> {
  const database = client ?? await getDatabase();
  const now = Date.now();
  await database.execute(
    `UPDATE learning_jobs
        SET status='succeeded',
            checkpoint_json=json_remove(
              json_set(checkpoint_json, '$.phase', 'completed'),
              '$.step', '$.reason', '$.runtimeRunId'
            ),
            result_json=$2, error_json=NULL, runtime_run_id=NULL,
            updated_at=$3, completed_at=$3
      WHERE id=$1 AND status='running'`,
    [id, JSON.stringify(result), now],
  );
}

export async function failLearningJob(
  id: string,
  error: unknown,
  client?: DatabaseClient,
): Promise<void> {
  const database = client ?? await getDatabase();
  const now = Date.now();
  const payload = serializeError(error, "learning.failed");
  await database.execute(
    `UPDATE learning_jobs
        SET status='failed',
            checkpoint_json=json_remove(
              json_set(checkpoint_json, '$.phase', 'failed'),
              '$.step', '$.reason', '$.runtimeRunId'
            ),
            error_json=$2, runtime_run_id=NULL, updated_at=$3, completed_at=$3
      WHERE id=$1 AND status='running'`,
    [id, JSON.stringify(payload), now],
  );
}

export async function interruptLearningJob(
  id: string,
  error: unknown,
  client?: DatabaseClient,
): Promise<void> {
  const database = client ?? await getDatabase();
  const now = Date.now();
  const payload = serializeError(error, "learning.interrupted");
  await database.execute(
    `UPDATE learning_jobs
        SET status='interrupted',
            checkpoint_json=json_remove(
              json_set(checkpoint_json, '$.phase', 'interrupted', '$.reason', 'execution_aborted'),
              '$.step', '$.runtimeRunId'
            ),
            error_json=$2, runtime_run_id=NULL, updated_at=$3, completed_at=NULL
      WHERE id=$1 AND status='running'`,
    [id, JSON.stringify(payload), now],
  );
}

export async function cancelLearningJob(id: string, client?: DatabaseClient): Promise<void> {
  const database = client ?? await getDatabase();
  const now = Date.now();
  await database.execute(
    `UPDATE learning_jobs
        SET status='cancelled',
            checkpoint_json=json_remove(
              json_set(checkpoint_json, '$.phase', 'cancelled'),
              '$.step', '$.reason', '$.runtimeRunId'
            ),
            runtime_run_id=NULL, updated_at=$2, completed_at=$2
      WHERE id=$1 AND status IN ('queued', 'running', 'interrupted')`,
    [id, now],
  );
}

export async function requeueLearningJob(id: string, client?: DatabaseClient): Promise<void> {
  const database = client ?? await getDatabase();
  const result = await database.execute(
    `UPDATE learning_jobs
        SET status='queued',
            checkpoint_json=json_remove(
              json_set(checkpoint_json, '$.phase', 'queued', '$.reason', 'user_retry'),
              '$.step', '$.runtimeRunId'
            ),
            error_json=NULL, result_json=NULL, runtime_run_id=NULL,
            updated_at=$2, completed_at=NULL
      WHERE id=$1 AND status IN ('failed', 'interrupted')`,
    [id, Date.now()],
  );
  if (result.rowsAffected !== 1) throw new Error("Learning job cannot be retried");
}

function mapLearningJob(row: LearningJobRow): LearningJob {
  const checkpoint = parseObject(row.checkpoint_json);
  return {
    id: row.id,
    type: row.type,
    sourceConversationId: row.source_conversation_id,
    ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    mode: checkpoint.mode === "auto_archive" ? "auto_archive" : "review",
    memoryNamespace: typeof checkpoint.memoryNamespace === "string" && checkpoint.memoryNamespace.trim()
      ? checkpoint.memoryNamespace.trim()
      : "global",
    status: row.status,
    checkpoint,
    ...(row.result_json ? { result: parseObject(row.result_json) } : {}),
    ...(row.error_json ? { error: parseError(row.error_json) } : {}),
    ...(row.runtime_run_id ? { runtimeRunId: row.runtime_run_id } : {}),
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function parseObject(json: string): Record<string, unknown> {
  const value = JSON.parse(json) as unknown;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseError(json: string): { message: string; code?: string } {
  const value = parseObject(json);
  return {
    message: typeof value.message === "string" ? value.message : "Learning job failed",
    ...(typeof value.code === "string" ? { code: value.code } : {}),
  };
}

function serializeError(error: unknown, code: string): { code: string; message: string } {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}
