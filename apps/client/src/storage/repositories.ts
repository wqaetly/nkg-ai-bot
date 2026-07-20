import { getDatabase, type DatabaseClient } from "./database";

interface Timestamps {
  createdAt: number;
  updatedAt: number;
}

export interface LocalRole extends Timestamps {
  id: string;
  name: string;
  systemPrompt: string;
  avatarUri?: string;
}

export interface StoredFlow extends Timestamps {
  id: string;
  version: string;
  name: string;
  graph: unknown;
}

export interface LocalAssistant extends Timestamps {
  id: string;
  name: string;
  description: string;
  flowId: string;
  flowVersion: string;
}

export interface LocalConversation extends Timestamps {
  id: string;
  title: string;
  roleId?: string;
  assistantId?: string;
}

export type LocalMessageRole = "system" | "user" | "assistant" | "tool";

export interface LocalMessage {
  id: string;
  conversationId: string;
  sequence: number;
  role: LocalMessageRole;
  content: unknown;
  createdAt: number;
}

type RoleRow = { id: string; name: string; system_prompt: string; avatar_uri: string | null; created_at: number; updated_at: number };
type FlowRow = { id: string; version: string; name: string; graph_json: string; created_at: number; updated_at: number };
type AssistantRow = { id: string; name: string; description: string; flow_id: string; flow_version: string; created_at: number; updated_at: number };
type ConversationRow = { id: string; title: string; role_id: string | null; assistant_id: string | null; created_at: number; updated_at: number };
type MessageRow = { id: string; conversation_id: string; sequence: number; role: LocalMessageRole; content_json: string; created_at: number };

export async function listRoles(client?: DatabaseClient): Promise<LocalRole[]> {
  const database = client ?? await getDatabase();
  const rows = await database.select<RoleRow[]>("SELECT * FROM roles ORDER BY updated_at DESC");
  return rows.map((row) => ({
    id: row.id, name: row.name, systemPrompt: row.system_prompt,
    ...(row.avatar_uri ? { avatarUri: row.avatar_uri } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}

export async function upsertRole(
  input: Pick<LocalRole, "id" | "name" | "systemPrompt" | "avatarUri">,
  client?: DatabaseClient,
): Promise<void> {
  requireText(input.id, "Role id"); requireText(input.name, "Role name"); requireText(input.systemPrompt, "System prompt");
  const database = client ?? await getDatabase(); const now = Date.now();
  await database.execute(
    `INSERT INTO roles (id, name, system_prompt, avatar_uri, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, system_prompt=excluded.system_prompt,
       avatar_uri=excluded.avatar_uri, updated_at=excluded.updated_at`,
    [input.id, input.name.trim(), input.systemPrompt.trim(), input.avatarUri?.trim() || null, now],
  );
}

export async function deleteRole(id: string, client?: DatabaseClient): Promise<void> {
  const database = client ?? await getDatabase(); await database.execute("DELETE FROM roles WHERE id=$1", [id]);
}

export async function listFlows(client?: DatabaseClient): Promise<StoredFlow[]> {
  const database = client ?? await getDatabase();
  const rows = await database.select<FlowRow[]>("SELECT * FROM flows ORDER BY updated_at DESC");
  return rows.map((row) => ({ id: row.id, version: row.version, name: row.name, graph: JSON.parse(row.graph_json) as unknown, createdAt: row.created_at, updatedAt: row.updated_at }));
}

export async function upsertFlow(
  input: Pick<StoredFlow, "id" | "version" | "name" | "graph">,
  client?: DatabaseClient,
): Promise<void> {
  requireText(input.id, "Flow id"); requireText(input.version, "Flow version"); requireText(input.name, "Flow name");
  assertFlowIdentity(input.graph, input.id, input.version);
  const database = client ?? await getDatabase(); const now = Date.now();
  await database.execute(
    `INSERT INTO flows (id, version, name, graph_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT(id, version) DO UPDATE SET name=excluded.name, graph_json=excluded.graph_json,
       updated_at=excluded.updated_at`,
    [input.id, input.version, input.name.trim(), JSON.stringify(input.graph), now],
  );
}

export async function deleteFlow(id: string, version: string, client?: DatabaseClient): Promise<void> {
  const database = client ?? await getDatabase(); await database.execute("DELETE FROM flows WHERE id=$1 AND version=$2", [id, version]);
}

export async function listAssistants(client?: DatabaseClient): Promise<LocalAssistant[]> {
  const database = client ?? await getDatabase();
  const rows = await database.select<AssistantRow[]>("SELECT * FROM assistants ORDER BY updated_at DESC");
  return rows.map((row) => ({ id: row.id, name: row.name, description: row.description, flowId: row.flow_id, flowVersion: row.flow_version, createdAt: row.created_at, updatedAt: row.updated_at }));
}

export async function upsertAssistant(
  input: Pick<LocalAssistant, "id" | "name" | "description" | "flowId" | "flowVersion">,
  client?: DatabaseClient,
): Promise<void> {
  requireText(input.id, "Assistant id"); requireText(input.name, "Assistant name"); requireText(input.flowId, "Flow id"); requireText(input.flowVersion, "Flow version");
  const database = client ?? await getDatabase(); const now = Date.now();
  await database.execute(
    `INSERT INTO assistants (id, name, description, flow_id, flow_version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
       flow_id=excluded.flow_id, flow_version=excluded.flow_version, updated_at=excluded.updated_at`,
    [input.id, input.name.trim(), input.description.trim(), input.flowId, input.flowVersion, now],
  );
}

export async function deleteAssistant(id: string, client?: DatabaseClient): Promise<void> {
  const database = client ?? await getDatabase(); await database.execute("DELETE FROM assistants WHERE id=$1", [id]);
}

export async function listConversations(client?: DatabaseClient): Promise<LocalConversation[]> {
  const database = client ?? await getDatabase();
  const rows = await database.select<ConversationRow[]>("SELECT * FROM conversations ORDER BY updated_at DESC");
  return rows.map((row) => ({ id: row.id, title: row.title, ...(row.role_id ? { roleId: row.role_id } : {}), ...(row.assistant_id ? { assistantId: row.assistant_id } : {}), createdAt: row.created_at, updatedAt: row.updated_at }));
}

export async function upsertConversation(
  input: Pick<LocalConversation, "id" | "title" | "roleId" | "assistantId">,
  client?: DatabaseClient,
): Promise<void> {
  requireText(input.id, "Conversation id");
  const database = client ?? await getDatabase(); const now = Date.now();
  await database.execute(
    `INSERT INTO conversations (id, title, role_id, assistant_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, role_id=excluded.role_id,
       assistant_id=excluded.assistant_id, updated_at=excluded.updated_at`,
    [input.id, input.title.trim(), input.roleId ?? null, input.assistantId ?? null, now],
  );
}

export async function deleteConversation(id: string, client?: DatabaseClient): Promise<void> {
  const database = client ?? await getDatabase(); await database.execute("DELETE FROM conversations WHERE id=$1", [id]);
}

export async function listMessages(conversationId: string, client?: DatabaseClient): Promise<LocalMessage[]> {
  const database = client ?? await getDatabase();
  const rows = await database.select<MessageRow[]>("SELECT * FROM messages WHERE conversation_id=$1 ORDER BY sequence", [conversationId]);
  return rows.map((row) => ({ id: row.id, conversationId: row.conversation_id, sequence: row.sequence, role: row.role, content: JSON.parse(row.content_json) as unknown, createdAt: row.created_at }));
}

export async function appendMessage(
  input: Pick<LocalMessage, "id" | "conversationId" | "role" | "content">,
  client?: DatabaseClient,
): Promise<LocalMessage> {
  requireText(input.id, "Message id"); requireText(input.conversationId, "Conversation id");
  if (!["system", "user", "assistant", "tool"].includes(input.role)) throw new Error("Invalid message role");
  const database = client ?? await getDatabase(); const now = Date.now();
  await database.execute(
    `INSERT INTO messages (id, conversation_id, sequence, role, content_json, created_at)
     SELECT $1, $2, COALESCE(MAX(sequence) + 1, 0), $3, $4, $5
       FROM messages WHERE conversation_id = $2`,
    [input.id, input.conversationId, input.role, JSON.stringify(input.content), now],
  );
  const [row] = await database.select<MessageRow[]>("SELECT * FROM messages WHERE id=$1", [input.id]);
  if (!row) throw new Error("Message was not persisted");
  return { id: row.id, conversationId: row.conversation_id, sequence: row.sequence, role: row.role, content: JSON.parse(row.content_json) as unknown, createdAt: row.created_at };
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function assertFlowIdentity(graph: unknown, id: string, version: string): void {
  if (!graph || typeof graph !== "object") throw new Error("Flow graph must be an object");
  const identity = graph as { id?: unknown; version?: unknown };
  if (identity.id !== id || identity.version !== version) {
    throw new Error("Flow graph identity must match the stored id and version");
  }
}
