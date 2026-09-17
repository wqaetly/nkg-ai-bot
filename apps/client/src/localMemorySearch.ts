import {
  listActiveMemoryItems,
  memoryIndexRevision,
  rankMemoryItems,
  type MemoryItem,
} from "./learningRepository";
import type { LocalEmbeddingRole } from "./localEmbedding";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getDatabase, type DatabaseClient, type ProviderProfile } from "./storage/database";

const DEFAULT_MAX_EMBEDDING_BACKFILL = 48;
const EMBEDDING_QUERY_PAGE_SIZE = 400;
const MAX_EMBEDDING_DIMENSIONS = 8_192;
const MIN_SEMANTIC_SIMILARITY = 0.2;

export type TextEmbeddingFunction = (
  texts: string[],
  roles: LocalEmbeddingRole[],
  signal?: AbortSignal,
) => Promise<number[][]>;

export interface LocalSemanticSearchOptions {
  query: string;
  namespace: string;
  limit?: number;
  modelKey: string;
  embedTexts: TextEmbeddingFunction;
  maxBackfill?: number;
  signal?: AbortSignal;
}

export interface LocalSemanticBackfillOptions {
  namespace: string;
  modelKey: string;
  embedTexts: TextEmbeddingFunction;
  batchSize?: number;
  signal?: AbortSignal;
}

export interface StoredMemoryEmbedding {
  memoryId: string;
  modelKey: string;
  contentFingerprint: string;
  vector: number[];
  updatedAt: number;
}

type MemoryEmbeddingRow = {
  memory_id: string;
  model_key: string;
  content_fingerprint: string;
  dimensions: number;
  vector_base64: string;
  updated_at: number;
};

export async function searchLocalMemoriesSemantically(
  options: LocalSemanticSearchOptions,
  client?: DatabaseClient,
): Promise<MemoryItem[]> {
  const revision = memoryIndexRevision;
  const items = await listActiveMemoryItems(options.namespace, undefined, client);
  if (items.length === 0) return [];

  const limit = Math.min(Math.max(Math.floor(options.limit ?? 8), 1), 20);
  const stored = await listStoredMemoryEmbeddings(options.modelKey, items, client);
  const lexicalOrder = rankMemoryItems(options.query, items, items.length);
  const pending = prioritizeEmbeddingBackfill(items, lexicalOrder, stored)
    .slice(0, Math.min(Math.max(Math.floor(
      options.maxBackfill ?? DEFAULT_MAX_EMBEDDING_BACKFILL,
    ), 0), 100));
  const embeddingTexts = [
    options.query.trim().slice(0, 4_000),
    ...pending.map((item) => item.content),
  ];
  const embeddingRoles: LocalEmbeddingRole[] = [
    "query",
    ...pending.map(() => "document" as const),
  ];
  const vectors = await options.embedTexts(
    embeddingTexts,
    embeddingRoles,
    options.signal,
  );
  validateEmbeddingBatch(vectors, embeddingTexts.length);
  const queryVector = vectors[0]!;
  const nextStored = new Map(stored);
  const generated: StoredMemoryEmbedding[] = [];
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index]!;
    const vector = vectors[index + 1]!;
    if (vector.length !== queryVector.length) {
      throw new Error("Embedding 服务为同一批文本返回了不同维度");
    }
    const embedding: StoredMemoryEmbedding = {
      memoryId: item.id,
      modelKey: options.modelKey,
      contentFingerprint: memoryContentFingerprint(item.content),
      vector,
      updatedAt: Date.now(),
    };
    generated.push(embedding);
    nextStored.set(item.id, embedding);
  }
  if (generated.length > 0) await upsertMemoryEmbeddings(generated, client);
  if (revision !== memoryIndexRevision) return [];

  if (isTauri()) {
    try {
      // ponytail: still reads the SQLite snapshot on every query; move incremental
      // ingestion into Rust when profiling shows snapshot transfer dominates ANN.
      const hits = await invoke<Array<{ id: string; similarity: number }>>("search_memory_index", {
        request: {
          namespace: options.namespace,
          modelKey: options.modelKey,
          vector: queryVector,
          records: [...nextStored.values()]
            .filter((embedding) => embedding.vector.length === queryVector.length
              && embedding.vector.some((value) => value !== 0))
            .map((embedding) => ({ id: embedding.memoryId, vector: embedding.vector })),
          limit: Math.min(200, Math.max(50, limit * 5)),
        },
      });
      if (revision !== memoryIndexRevision) {
        // The native command may have been queued behind a reset. Discard its
        // stale snapshot and remove the derived files it could have recreated.
        await invoke("reset_memory_index");
        return [];
      }
      if (options.signal?.aborted) throw abortError(options.signal.reason);
      const similarities = new Map(hits.map((hit) => [hit.id, hit.similarity]));
      // Include lexical candidates and use exact cosine for those outside ANN top-k.
      for (const item of lexicalOrder.slice(0, Math.max(50, limit * 5))) {
        const vector = nextStored.get(item.id)?.vector;
        if (vector && !similarities.has(item.id)) {
          similarities.set(item.id, cosineSimilarity(queryVector, vector));
        }
      }
      return rankHybridMemoryItems(options.query, items, queryVector,
        new Map(), limit, similarities);
    } catch (cause: unknown) {
      if (options.signal?.aborted) throw abortError(options.signal.reason);
      if (revision !== memoryIndexRevision) return [];
      console.warn("zvec 检索失败，已回退到本地余弦检索", cause);
    }
  }

  return rankHybridMemoryItems(
    options.query,
    items,
    queryVector,
    new Map([...nextStored].map(([id, embedding]) => [id, embedding.vector])),
    limit,
  );
}

export async function backfillLocalMemoryEmbeddings(
  options: LocalSemanticBackfillOptions,
  client?: DatabaseClient,
): Promise<number> {
  const items = await listActiveMemoryItems(options.namespace, undefined, client);
  if (items.length === 0) return 0;
  const stored = await listStoredMemoryEmbeddings(options.modelKey, items, client);
  const pending = prioritizeEmbeddingBackfill(items, items, stored);
  const batchSize = Math.min(Math.max(Math.floor(options.batchSize ?? 8), 1), 16);
  let completed = 0;
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    if (options.signal?.aborted) throw abortError(options.signal.reason);
    const batch = pending.slice(offset, offset + batchSize);
    const vectors = await options.embedTexts(
      batch.map((item) => item.content),
      batch.map(() => "document"),
      options.signal,
    );
    validateEmbeddingBatch(vectors, batch.length);
    const timestamp = Date.now();
    await upsertMemoryEmbeddings(batch.map((item, index) => ({
      memoryId: item.id,
      modelKey: options.modelKey,
      contentFingerprint: memoryContentFingerprint(item.content),
      vector: vectors[index]!,
      updatedAt: timestamp,
    })), client);
    completed += batch.length;
    await yieldToEventLoop();
  }
  return completed;
}

export async function requestTextEmbeddings(
  baseUrl: string,
  apiKey: string,
  model: string,
  inputs: string[],
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<number[][]> {
  const normalizedModel = model.trim();
  if (!normalizedModel) throw new Error("Embedding 模型不能为空");
  if (inputs.length === 0 || inputs.some((input) => !input.trim())) {
    throw new Error("Embedding 文本不能为空");
  }
  const endpoint = new URL(baseUrl.trim());
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("Embedding API URL 必须使用 HTTP 或 HTTPS");
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/embeddings`;
  endpoint.search = "";
  endpoint.hash = "";
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ model: normalizedModel, input: inputs }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Embedding 请求失败：HTTP ${response.status}`);
  }
  const payload = await response.json() as unknown;
  const data = payload && typeof payload === "object"
    ? (payload as { data?: unknown }).data
    : undefined;
  if (!Array.isArray(data) || data.length !== inputs.length) {
    throw new Error("Embedding 服务返回的向量数量不正确");
  }
  const ordered = data.map((row, position) => {
    if (!row || typeof row !== "object") throw new Error("Embedding 服务返回了无效数据");
    const candidate = row as { index?: unknown; embedding?: unknown };
    const index = typeof candidate.index === "number" ? candidate.index : position;
    if (!Number.isInteger(index) || index < 0 || index >= inputs.length) {
      throw new Error("Embedding 服务返回了无效索引");
    }
    if (!Array.isArray(candidate.embedding)
      || candidate.embedding.length === 0
      || candidate.embedding.length > MAX_EMBEDDING_DIMENSIONS
      || candidate.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error("Embedding 服务返回了无效向量");
    }
    return { index, vector: candidate.embedding as number[] };
  }).sort((left, right) => left.index - right.index);
  if (ordered.some((item, index) => item.index !== index)) {
    throw new Error("Embedding 服务返回的向量索引不完整");
  }
  const dimensions = ordered[0]!.vector.length;
  if (ordered.some((item) => item.vector.length !== dimensions)) {
    throw new Error("Embedding 服务为同一批文本返回了不同维度");
  }
  return ordered.map((item) => item.vector);
}

export function rankHybridMemoryItems(
  query: string,
  items: MemoryItem[],
  queryVector: number[],
  itemVectors: ReadonlyMap<string, number[]>,
  limit = 8,
  similarities?: ReadonlyMap<string, number>,
): MemoryItem[] {
  if (limit <= 0 || queryVector.length === 0) return [];
  const lexical = rankMemoryItems(query, items, items.length);
  const lexicalScores = new Map(lexical.map((item, index) => [
    item.id,
    1 - (index / Math.max(lexical.length, 1)),
  ]));
  return items.map((item) => {
    const vector = itemVectors.get(item.id);
    const similarity = similarities ? similarities.get(item.id) : vector?.length === queryVector.length
      ? cosineSimilarity(queryVector, vector)
      : undefined;
    const lexicalScore = lexicalScores.get(item.id) ?? 0;
    const semanticScore = similarity === undefined ? 0 : Math.max(0, similarity);
    return {
      item,
      similarity,
      score: semanticScore * 0.75 + lexicalScore * 0.25,
      lexicalScore,
    };
  }).filter(({ similarity, lexicalScore }) => (
    lexicalScore > 0 || (similarity !== undefined && similarity >= MIN_SEMANTIC_SIMILARITY)
  )).sort((left, right) => (
    right.score - left.score || right.item.updatedAt - left.item.updatedAt
  )).slice(0, limit).map(({ item }) => item);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return -1;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function memoryEmbeddingModelKey(provider: ProviderProfile, model: string): string {
  return `${provider.id}\u001f${provider.baseUrl}\u001f${model.trim()}`;
}

export function memoryContentFingerprint(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${content.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

async function listStoredMemoryEmbeddings(
  modelKey: string,
  items: MemoryItem[],
  client?: DatabaseClient,
): Promise<Map<string, StoredMemoryEmbedding>> {
  if (items.length === 0) return new Map();
  const database = client ?? await getDatabase();
  const contentById = new Map(items.map((item) => [item.id, item.content]));
  const embeddings = new Map<string, StoredMemoryEmbedding>();
  for (let offset = 0; offset < items.length; offset += EMBEDDING_QUERY_PAGE_SIZE) {
    const page = items.slice(offset, offset + EMBEDDING_QUERY_PAGE_SIZE);
    const placeholders = page.map((_, index) => `$${index + 2}`).join(", ");
    const rows = await database.select<MemoryEmbeddingRow[]>(
      `SELECT memory_id, model_key, content_fingerprint, dimensions, vector_base64, updated_at
         FROM memory_item_embeddings
        WHERE model_key=$1 AND memory_id IN (${placeholders})`,
      [modelKey, ...page.map((item) => item.id)],
    );
    for (const row of rows) {
      const content = contentById.get(row.memory_id);
      if (!content || row.content_fingerprint !== memoryContentFingerprint(content)) continue;
      const vector = decodeFloat32Vector(row.vector_base64, row.dimensions);
      if (!vector) continue;
      embeddings.set(row.memory_id, {
        memoryId: row.memory_id,
        modelKey: row.model_key,
        contentFingerprint: row.content_fingerprint,
        vector,
        updatedAt: row.updated_at,
      });
    }
  }
  return embeddings;
}

function prioritizeEmbeddingBackfill(
  items: MemoryItem[],
  lexicalOrder: MemoryItem[],
  stored: ReadonlyMap<string, StoredMemoryEmbedding>,
): MemoryItem[] {
  const seen = new Set<string>();
  const pending: MemoryItem[] = [];
  for (const item of [...lexicalOrder, ...items]) {
    if (seen.has(item.id) || stored.has(item.id)) continue;
    seen.add(item.id);
    pending.push(item);
  }
  return pending;
}

async function upsertMemoryEmbeddings(
  embeddings: StoredMemoryEmbedding[],
  client?: DatabaseClient,
): Promise<void> {
  if (embeddings.length === 0) return;
  const database = client ?? await getDatabase();
  const bindValues: unknown[] = [];
  const values = embeddings.map((embedding, rowIndex) => {
    const offset = rowIndex * 7;
    bindValues.push(
      embedding.memoryId,
      embedding.modelKey,
      embedding.contentFingerprint,
      embedding.vector.length,
      encodeFloat32Vector(embedding.vector),
      embedding.updatedAt,
      embedding.updatedAt,
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`;
  }).join(", ");
  await database.execute(
    `INSERT INTO memory_item_embeddings
       (memory_id, model_key, content_fingerprint, dimensions, vector_base64, created_at, updated_at)
     VALUES ${values}
     ON CONFLICT(memory_id, model_key) DO UPDATE SET
       content_fingerprint=excluded.content_fingerprint,
       dimensions=excluded.dimensions,
       vector_base64=excluded.vector_base64,
       updated_at=excluded.updated_at`,
    bindValues,
  );
}

function encodeFloat32Vector(vector: number[]): string {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => view.setFloat32(index * 4, value, true));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeFloat32Vector(encoded: string, dimensions: number): number[] | undefined {
  if (!Number.isInteger(dimensions) || dimensions <= 0 || dimensions > MAX_EMBEDDING_DIMENSIONS) {
    return undefined;
  }
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    return undefined;
  }
  if (binary.length !== dimensions * 4) return undefined;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  const vector = Array.from({ length: dimensions }, (_, index) => view.getFloat32(index * 4, true));
  return vector.every(Number.isFinite) ? vector : undefined;
}

function validateEmbeddingBatch(vectors: number[][], expected: number): void {
  if (vectors.length !== expected) throw new Error("Embedding 服务返回的向量数量不正确");
  const dimensions = vectors[0]?.length ?? 0;
  if (dimensions <= 0 || dimensions > MAX_EMBEDDING_DIMENSIONS || vectors.some((vector) => (
    vector.length !== dimensions
    || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ))) {
    throw new Error("Embedding 服务返回了无效向量");
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException("记忆向量索引已取消", "AbortError");
}
