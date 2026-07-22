import type { MemoryServiceConfig } from "./storage/database";

export const DEFAULT_MEMOS_URL = "https://memos.memtensor.cn/api/openmem/v1";
export const MEMOS_APP_ID = "nkg-ai-bot";

export interface RemoteMemory {
  id?: string;
  content: string;
  relativity?: number;
  source: "memos";
}

export interface MemorySearchOptions {
  signal?: AbortSignal;
  limit?: number;
}

export async function searchMemosMemories(
  config: MemoryServiceConfig,
  apiKey: string,
  query: string,
  conversationId: string,
  fetchImpl: typeof globalThis.fetch,
  options: MemorySearchOptions = {},
): Promise<RemoteMemory[]> {
  const normalizedQuery = query.trim().slice(0, 4_000);
  if (!normalizedQuery) return [];
  const limit = Math.max(1, Math.min(20, options.limit ?? 6));
  const payload = await postMemosJson(
    config,
    apiKey,
    "search/memory",
    {
      query: normalizedQuery,
      user_id: config.userId,
      conversation_id: conversationId,
      memory_limit_number: limit,
      include_preference: false,
      include_tool_memory: false,
      include_skill: false,
      filter: { and: [{ app_id: MEMOS_APP_ID }] },
    },
    fetchImpl,
    options.signal,
  );
  return extractMemories(payload, limit);
}

export async function addMemosTurn(
  config: MemoryServiceConfig,
  apiKey: string,
  conversationId: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<void> {
  if (messages.length === 0 || messages.every((message) => !message.content.trim())) return;
  await postMemosJson(
    config,
    apiKey,
    "add/message",
    {
      user_id: config.userId,
      conversation_id: conversationId,
      async_mode: true,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content.trim(),
      })),
      tags: ["nkg-ai-bot", "chat"],
      info: {
        app_id: MEMOS_APP_ID,
        module: "Chat",
        business_type: "desktop_mobile_app",
        scene: "chat",
        lang: "zh",
      },
    },
    fetchImpl,
    signal,
  );
}

export async function testMemosConnection(
  config: MemoryServiceConfig,
  apiKey: string,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<number> {
  const memories = await searchMemosMemories(
    config,
    apiKey,
    "连接测试",
    `connection-test-${Date.now()}`,
    fetchImpl,
    { signal, limit: 1 },
  );
  return memories.length;
}

async function postMemosJson(
  config: MemoryServiceConfig,
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const endpoint = new URL(`${config.baseUrl.replace(/\/$/, "")}/${path}`);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403
      ? "，请检查 API Key 与项目权限"
      : "";
    throw new Error(`MemOS 请求失败：HTTP ${response.status}${hint}`);
  }
  const payload = await response.json() as unknown;
  if (payload && typeof payload === "object") {
    const envelope = payload as { code?: unknown; message?: unknown };
    if (typeof envelope.code === "number" && envelope.code !== 0) {
      const message = typeof envelope.message === "string" ? envelope.message.slice(0, 300) : "服务返回错误";
      throw new Error(`MemOS 请求失败（${envelope.code}）：${message}`);
    }
  }
  return payload;
}

function extractMemories(payload: unknown, limit: number): RemoteMemory[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as { data?: unknown };
  const data: Record<string, unknown> = root.data && typeof root.data === "object"
    ? root.data as Record<string, unknown>
    : payload as Record<string, unknown>;
  const rows = [
    ...arrayValue(data.memory_detail_list),
    ...arrayValue(data.preference_detail_list),
    ...arrayValue(data.profile_detail_list),
    ...arrayValue(data.event_detail_list),
  ];
  const seen = new Set<string>();
  const memories: RemoteMemory[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const content = firstString(item.memory_value, item.content, item.value, item.text);
    if (!content || seen.has(content)) continue;
    seen.add(content);
    memories.push({
      source: "memos",
      content,
      ...(typeof item.id === "string" ? { id: item.id } : {}),
      ...(typeof item.relativity === "number" ? { relativity: item.relativity } : {}),
    });
    if (memories.length >= limit) break;
  }
  return memories;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
