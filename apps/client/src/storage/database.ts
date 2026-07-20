import Database from "@tauri-apps/plugin-sql";

const DATABASE_URL = "sqlite:nkg-ai-bot.db";
const SELECTED_PROVIDER_KEY = "selected_provider_id";
let databasePromise: Promise<Database> | undefined;

export interface DatabaseClient {
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
}

export function getDatabase(): Promise<Database> {
  databasePromise ??= Database.load(DATABASE_URL).catch((error: unknown) => {
    databasePromise = undefined;
    throw error;
  });
  return databasePromise;
}

export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  apiKeyRef: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderProfileInput {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  apiKeyRef: string;
}

interface ProviderProfileRow {
  id: string;
  name: string;
  base_url: string;
  default_model: string;
  api_key_ref: string;
  created_at: number;
  updated_at: number;
}

interface SettingRow {
  value_json: string;
}

export async function listProviderProfiles(
  client?: DatabaseClient,
): Promise<ProviderProfile[]> {
  const database = client ?? await getDatabase();
  const rows = await database.select<ProviderProfileRow[]>(
    `SELECT id, name, base_url, default_model, api_key_ref, created_at, updated_at
       FROM provider_profiles
      ORDER BY updated_at DESC`,
  );
  return rows.map(mapProviderProfile);
}

export async function getProviderProfile(
  id: string,
  client?: DatabaseClient,
): Promise<ProviderProfile | undefined> {
  const database = client ?? await getDatabase();
  const [row] = await database.select<ProviderProfileRow[]>(
    `SELECT id, name, base_url, default_model, api_key_ref, created_at, updated_at
       FROM provider_profiles WHERE id = $1`,
    [id],
  );
  return row ? mapProviderProfile(row) : undefined;
}

export async function upsertProviderProfile(
  input: ProviderProfileInput,
  client?: DatabaseClient,
): Promise<ProviderProfile> {
  const profile = normalizeProviderProfile(input);
  const database = client ?? await getDatabase();
  const now = Date.now();
  await database.execute(
    `INSERT INTO provider_profiles
       (id, name, base_url, default_model, api_key_ref, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       base_url = excluded.base_url,
       default_model = excluded.default_model,
       api_key_ref = excluded.api_key_ref,
       updated_at = excluded.updated_at`,
    [
      profile.id,
      profile.name,
      profile.baseUrl,
      profile.defaultModel,
      profile.apiKeyRef,
      now,
    ],
  );
  const saved = await getProviderProfile(profile.id, database);
  if (!saved) throw new Error("Provider profile was not persisted");
  return saved;
}

export async function deleteProviderProfile(
  id: string,
  client?: DatabaseClient,
): Promise<void> {
  const database = client ?? await getDatabase();
  await database.execute("DELETE FROM provider_profiles WHERE id = $1", [id]);
}

export async function getSelectedProviderId(
  client?: DatabaseClient,
): Promise<string | undefined> {
  const database = client ?? await getDatabase();
  const [row] = await database.select<SettingRow[]>(
    "SELECT value_json FROM app_settings WHERE key = $1",
    [SELECTED_PROVIDER_KEY],
  );
  if (!row) return undefined;
  try {
    const value = JSON.parse(row.value_json) as unknown;
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function setSelectedProviderId(
  id: string | undefined,
  client?: DatabaseClient,
): Promise<void> {
  const database = client ?? await getDatabase();
  if (!id) {
    await database.execute("DELETE FROM app_settings WHERE key = $1", [SELECTED_PROVIDER_KEY]);
    return;
  }
  const now = Date.now();
  await database.execute(
    `INSERT INTO app_settings (key, value_json, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
    [SELECTED_PROVIDER_KEY, JSON.stringify(id), now],
  );
}

export function normalizeProviderProfile(input: ProviderProfileInput): ProviderProfileInput {
  const id = input.id.trim();
  const name = input.name.trim();
  const defaultModel = input.defaultModel.trim();
  const apiKeyRef = input.apiKeyRef.trim();
  if (!id || !name || !defaultModel || !apiKeyRef) {
    throw new Error("Provider id, name, model and API Key reference are required");
  }
  const url = new URL(input.baseUrl.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Provider API URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Provider API URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("Provider API URL must not contain a query or fragment");
  }
  return {
    id,
    name,
    baseUrl: url.toString().replace(/\/$/, ""),
    defaultModel,
    apiKeyRef,
  };
}

function mapProviderProfile(row: ProviderProfileRow): ProviderProfile {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    defaultModel: row.default_model,
    apiKeyRef: row.api_key_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
