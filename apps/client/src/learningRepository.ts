import { getDatabase, type DatabaseClient } from "./storage/database";
import { invoke, isTauri } from "@tauri-apps/api/core";

// In-flight searches must not return a snapshot from before a manual mutation.
export let memoryIndexRevision = 0;

async function resetMemoryIndex(): Promise<void> {
  memoryIndexRevision += 1;
  if (isTauri()) await invoke("reset_memory_index");
}

export type FeedbackRating = "positive" | "negative";
export type LearningCandidateStatus = "pending" | "approved" | "rejected";
export type MemoryItemStatus = "active" | "disabled";

export interface MessageFeedback {
  id: string;
  messageId: string;
  conversationId: string;
  rating: FeedbackRating;
  correction?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryFactProposal {
  content: string;
  confidence: number;
}

export interface LearningCandidate {
  id: string;
  kind: "memory_fact";
  namespace: string;
  sourceMessageId?: string;
  sourceConversationId?: string;
  jobId?: string;
  proposal: MemoryFactProposal;
  rationale: string;
  status: LearningCandidateStatus;
  targetId?: string;
  createdAt: number;
  updatedAt: number;
  reviewedAt?: number;
}

export interface MemoryItem {
  id: string;
  namespace: string;
  content: string;
  sourceMessageId?: string;
  confidence: number;
  status: MemoryItemStatus;
  createdAt: number;
  updatedAt: number;
}

type FeedbackRow = {
  id: string;
  message_id: string;
  conversation_id: string;
  rating: FeedbackRating;
  correction: string | null;
  created_at: number;
  updated_at: number;
};

type CandidateRow = {
  id: string;
  kind: "memory_fact";
  namespace: string;
  source_message_id: string | null;
  source_conversation_id: string | null;
  job_id: string | null;
  proposal_json: string;
  rationale: string;
  status: LearningCandidateStatus;
  target_id: string | null;
  created_at: number;
  updated_at: number;
  reviewed_at: number | null;
};

type MemoryRow = {
  id: string;
  namespace: string;
  content: string;
  source_message_id: string | null;
  confidence: number;
  status: MemoryItemStatus;
  created_at: number;
  updated_at: number;
};

export async function listMessageFeedback(
  conversationId: string,
  client?: DatabaseClient,
): Promise<MessageFeedback[]> {
  const database = client ?? await getDatabase();
  const rows = await database.select<FeedbackRow[]>(
    "SELECT * FROM message_feedback WHERE conversation_id=$1 ORDER BY updated_at DESC",
    [conversationId],
  );
  return rows.map(mapFeedback);
}

export async function upsertMessageFeedback(
  input: {
    messageId: string;
    conversationId: string;
    rating: FeedbackRating;
    correction?: string;
  },
  client?: DatabaseClient,
): Promise<MessageFeedback> {
  requireText(input.messageId, "Message id");
  requireText(input.conversationId, "Conversation id");
  const database = client ?? await getDatabase();
  const now = Date.now();
  await database.execute(
    `INSERT INTO message_feedback
       (id, message_id, conversation_id, rating, correction, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT(message_id) DO UPDATE SET
       rating=excluded.rating, correction=COALESCE(excluded.correction, message_feedback.correction),
       updated_at=excluded.updated_at`,
    [
      crypto.randomUUID(),
      input.messageId,
      input.conversationId,
      input.rating,
      input.correction?.trim() || null,
      now,
    ],
  );
  const [row] = await database.select<FeedbackRow[]>(
    "SELECT * FROM message_feedback WHERE message_id=$1",
    [input.messageId],
  );
  if (!row) throw new Error("Feedback was not persisted");
  return mapFeedback(row);
}

export async function proposeMemoryCandidate(
  input: {
    content: string;
    namespace?: string;
    sourceMessageId?: string;
    sourceConversationId?: string;
    jobId?: string;
    rationale?: string;
    confidence?: number;
  },
  client?: DatabaseClient,
): Promise<LearningCandidate> {
  const content = normalizeMemoryContent(input.content);
  const namespace = normalizeNamespace(input.namespace);
  const confidence = normalizeConfidence(input.confidence ?? 1);
  const database = client ?? await getDatabase();
  const now = Date.now();
  const id = crypto.randomUUID();
  await database.execute(
    `INSERT INTO learning_candidates
       (id, kind, namespace, source_message_id, source_conversation_id, job_id,
        proposal_json, rationale, status, created_at, updated_at)
     VALUES ($1, 'memory_fact', $2, $3, $4, $5, $6, $7, 'pending', $8, $8)`,
    [
      id,
      namespace,
      input.sourceMessageId ?? null,
      input.sourceConversationId ?? null,
      input.jobId ?? null,
      JSON.stringify({ content, confidence }),
      input.rationale?.trim() || "用户从对话中手动标记",
      now,
    ],
  );
  const candidate = await getLearningCandidate(id, database);
  if (!candidate) throw new Error("Learning candidate was not persisted");
  return candidate;
}

export async function listLearningCandidates(
  status: LearningCandidateStatus = "pending",
  client?: DatabaseClient,
): Promise<LearningCandidate[]> {
  const database = client ?? await getDatabase();
  const rows = await database.select<CandidateRow[]>(
    "SELECT * FROM learning_candidates WHERE status=$1 ORDER BY created_at DESC",
    [status],
  );
  return rows.map(mapCandidate);
}

export async function approveMemoryCandidate(
  id: string,
  client?: DatabaseClient,
): Promise<MemoryItem> {
  const database = client ?? await getDatabase();
  const candidate = await getLearningCandidate(id, database);
  if (!candidate || candidate.status !== "pending") {
    throw new Error("Pending memory candidate was not found");
  }
  const content = normalizeMemoryContent(candidate.proposal.content);
  const contentKey = memoryContentKey(content);
  const memoryId = crypto.randomUUID();
  const now = Date.now();
  await database.execute(
    `INSERT INTO memory_items
       (id, namespace, content, content_key, source_message_id, confidence, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7)
     ON CONFLICT(namespace, content_key) DO UPDATE SET
       content=excluded.content, source_message_id=COALESCE(excluded.source_message_id, memory_items.source_message_id),
       confidence=MAX(memory_items.confidence, excluded.confidence), status='active', updated_at=excluded.updated_at`,
    [
      memoryId,
      candidate.namespace,
      content,
      contentKey,
      candidate.sourceMessageId ?? null,
      normalizeConfidence(candidate.proposal.confidence),
      now,
    ],
  );
  const [stored] = await database.select<MemoryRow[]>(
    "SELECT * FROM memory_items WHERE namespace=$1 AND content_key=$2",
    [candidate.namespace, contentKey],
  );
  if (!stored) throw new Error("Approved memory was not persisted");
  await database.execute(
    `UPDATE learning_candidates
        SET status='approved', target_id=$2, reviewed_at=$3, updated_at=$3
      WHERE id=$1 AND status='pending'`,
    [id, stored.id, now],
  );
  return mapMemory(stored);
}

export async function rejectLearningCandidate(
  id: string,
  client?: DatabaseClient,
): Promise<void> {
  const database = client ?? await getDatabase();
  const now = Date.now();
  await database.execute(
    `UPDATE learning_candidates
        SET status='rejected', reviewed_at=$2, updated_at=$2
      WHERE id=$1 AND status='pending'`,
    [id, now],
  );
}

export async function updateMemoryCandidateContent(
  id: string,
  content: string,
  client?: DatabaseClient,
): Promise<void> {
  const database = client ?? await getDatabase();
  const candidate = await getLearningCandidate(id, database);
  if (!candidate || candidate.status !== "pending") {
    throw new Error("Pending memory candidate was not found");
  }
  const proposal: MemoryFactProposal = {
    ...candidate.proposal,
    content: normalizeMemoryContent(content),
  };
  await database.execute(
    "UPDATE learning_candidates SET proposal_json=$2, updated_at=$3 WHERE id=$1 AND status='pending'",
    [id, JSON.stringify(proposal), Date.now()],
  );
}

export async function listMemoryItems(
  status?: MemoryItemStatus,
  client?: DatabaseClient,
): Promise<MemoryItem[]> {
  const database = client ?? await getDatabase();
  const rows = status
    ? await database.select<MemoryRow[]>(
      "SELECT * FROM memory_items WHERE status=$1 ORDER BY updated_at DESC",
      [status],
    )
    : await database.select<MemoryRow[]>("SELECT * FROM memory_items ORDER BY updated_at DESC");
  return rows.map(mapMemory);
}

export async function setMemoryItemStatus(
  id: string,
  status: MemoryItemStatus,
  client?: DatabaseClient,
): Promise<void> {
  const database = client ?? await getDatabase();
  await database.execute(
    "UPDATE memory_items SET status=$2, updated_at=$3 WHERE id=$1",
    [id, status, Date.now()],
  );
  await resetMemoryIndex();
}

export async function updateMemoryItemContent(
  id: string,
  content: string,
  client?: DatabaseClient,
): Promise<void> {
  const normalized = normalizeMemoryContent(content);
  const database = client ?? await getDatabase();
  await database.execute(
    "UPDATE memory_items SET content=$2, content_key=$3, updated_at=$4 WHERE id=$1",
    [id, normalized, memoryContentKey(normalized), Date.now()],
  );
  await resetMemoryIndex();
}

export async function deleteMemoryItem(id: string, client?: DatabaseClient): Promise<void> {
  const database = client ?? await getDatabase();
  await database.execute("DELETE FROM memory_items WHERE id=$1", [id]);
  await resetMemoryIndex();
}

export async function listRelevantMemories(
  query: string,
  limit = 8,
  namespace = "global",
  client?: DatabaseClient,
): Promise<MemoryItem[]> {
  const items = await listActiveMemoryItems(namespace, undefined, client);
  return rankMemoryItems(query, items, Math.min(Math.max(limit, 0), 20));
}

export async function listActiveMemoryItems(
  namespace = "global",
  limit?: number,
  client?: DatabaseClient,
): Promise<MemoryItem[]> {
  const database = client ?? await getDatabase();
  const normalizedNamespace = normalizeNamespace(namespace);
  const rows = limit === undefined
    ? await database.select<MemoryRow[]>(
      "SELECT * FROM memory_items WHERE status='active' AND namespace=$1 ORDER BY updated_at DESC",
      [normalizedNamespace],
    )
    : await database.select<MemoryRow[]>(
      "SELECT * FROM memory_items WHERE status='active' AND namespace=$1 ORDER BY updated_at DESC LIMIT $2",
      [normalizedNamespace, Math.max(Math.floor(limit), 0)],
    );
  return rows.map(mapMemory);
}

export function rankMemoryItems(query: string, items: MemoryItem[], limit = 8): MemoryItem[] {
  if (limit <= 0) return [];
  const queryTerms = terms(query);
  if (queryTerms.size === 0) return [];
  return items
    .map((item) => {
      const itemTerms = terms(item.content);
      let overlap = 0;
      for (const term of queryTerms) {
        if (itemTerms.has(term)) overlap += term.length > 1 ? 2 : 1;
      }
      return { item, score: overlap / Math.max(queryTerms.size, 1) };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.item.updatedAt - left.item.updatedAt)
    .slice(0, limit)
    .map(({ item }) => item);
}

export function normalizeMemoryContent(content: string): string {
  const normalized = content.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("记忆内容不能为空");
  if (normalized.length > 1_000) throw new Error("单条记忆不能超过 1000 个字符");
  return normalized;
}

function getLearningCandidate(
  id: string,
  database: DatabaseClient,
): Promise<LearningCandidate | undefined> {
  return database.select<CandidateRow[]>(
    "SELECT * FROM learning_candidates WHERE id=$1",
    [id],
  ).then(([row]) => row ? mapCandidate(row) : undefined);
}

function mapFeedback(row: FeedbackRow): MessageFeedback {
  return {
    id: row.id,
    messageId: row.message_id,
    conversationId: row.conversation_id,
    rating: row.rating,
    ...(row.correction ? { correction: row.correction } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCandidate(row: CandidateRow): LearningCandidate {
  const proposal = JSON.parse(row.proposal_json) as MemoryFactProposal;
  return {
    id: row.id,
    kind: row.kind,
    namespace: row.namespace,
    ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    ...(row.source_conversation_id ? { sourceConversationId: row.source_conversation_id } : {}),
    ...(row.job_id ? { jobId: row.job_id } : {}),
    proposal,
    rationale: row.rationale,
    status: row.status,
    ...(row.target_id ? { targetId: row.target_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.reviewed_at === null ? {} : { reviewedAt: row.reviewed_at }),
  };
}

function mapMemory(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    namespace: row.namespace,
    content: row.content,
    ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    confidence: row.confidence,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeNamespace(namespace?: string): string {
  const normalized = namespace?.trim() || "global";
  if (normalized.length > 120) throw new Error("Memory namespace is too long");
  return normalized;
}

function normalizeConfidence(confidence: number): number {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Memory confidence must be between 0 and 1");
  }
  return confidence;
}

function memoryContentKey(content: string): string {
  return content.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function terms(content: string): Set<string> {
  const normalized = content.toLocaleLowerCase();
  const result = new Set<string>();
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const run = match[0];
    for (const character of run) result.add(character);
    for (let index = 0; index < run.length - 1; index += 1) {
      result.add(run.slice(index, index + 2));
    }
  }
  for (const match of normalized.matchAll(/[\p{L}\p{N}_-]{2,}/gu)) {
    result.add(match[0]);
  }
  return result;
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}
