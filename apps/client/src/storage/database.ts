import Database from "@tauri-apps/plugin-sql";
import type { AffiliateCommerceConfig } from "@nkg-ai-bot/commerce-flow";

const DATABASE_URL = "sqlite:nkg-ai-bot.db";
const SELECTED_PROVIDER_KEY = "selected_provider_id";
const WEB_SEARCH_CONFIG_KEY = "web_search_config";
const MEMORY_SERVICE_CONFIG_KEY = "memory_service_config";
const AFFILIATE_COMMERCE_CONFIG_KEY = "affiliate_commerce_config";
export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
export const MIN_MODEL_CONTEXT_WINDOW = 4_096;
export const MAX_MODEL_CONTEXT_WINDOW = 2_000_000;
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
  enabledModels: string[];
  modelContextWindows?: Record<string, number>;
  apiKeyRef: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderProfileInput {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  enabledModels: string[];
  modelContextWindows?: Record<string, number>;
  apiKeyRef: string;
}

export interface WebSearchConfig {
  provider: "searxng";
  baseUrl: string;
  apiKeyRef: string;
  enabled: boolean;
}

export interface MemoryServiceConfig {
  provider: "memos";
  baseUrl: string;
  userId: string;
  apiKeyRef: string;
  enabled: boolean;
}

export type { AffiliateCommerceConfig } from "@nkg-ai-bot/commerce-flow";

interface ProviderProfileRow {
  id: string;
  name: string;
  base_url: string;
  default_model: string;
  enabled_models_json: string;
  model_context_windows_json: string;
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
    `SELECT id, name, base_url, default_model, enabled_models_json, model_context_windows_json,
            api_key_ref, created_at, updated_at
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
    `SELECT id, name, base_url, default_model, enabled_models_json, model_context_windows_json,
            api_key_ref, created_at, updated_at
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
       (id, name, base_url, default_model, enabled_models_json, model_context_windows_json,
        api_key_ref, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       base_url = excluded.base_url,
       default_model = excluded.default_model,
       enabled_models_json = excluded.enabled_models_json,
       model_context_windows_json = excluded.model_context_windows_json,
       api_key_ref = excluded.api_key_ref,
       updated_at = excluded.updated_at`,
    [
      profile.id,
      profile.name,
      profile.baseUrl,
      profile.defaultModel,
      JSON.stringify(profile.enabledModels),
      JSON.stringify(profile.modelContextWindows),
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

export async function getWebSearchConfig(
  client?: DatabaseClient,
): Promise<WebSearchConfig | undefined> {
  const database = client ?? await getDatabase();
  const [row] = await database.select<SettingRow[]>(
    "SELECT value_json FROM app_settings WHERE key = $1",
    [WEB_SEARCH_CONFIG_KEY],
  );
  if (!row) return undefined;
  try {
    return normalizeWebSearchConfig(JSON.parse(row.value_json) as WebSearchConfig);
  } catch {
    return undefined;
  }
}

export async function setWebSearchConfig(
  input: WebSearchConfig,
  client?: DatabaseClient,
): Promise<WebSearchConfig> {
  const config = normalizeWebSearchConfig(input);
  const database = client ?? await getDatabase();
  await database.execute(
    `INSERT INTO app_settings (key, value_json, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
    [WEB_SEARCH_CONFIG_KEY, JSON.stringify(config), Date.now()],
  );
  return config;
}

export async function getMemoryServiceConfig(
  client?: DatabaseClient,
): Promise<MemoryServiceConfig | undefined> {
  const database = client ?? await getDatabase();
  const [row] = await database.select<SettingRow[]>(
    "SELECT value_json FROM app_settings WHERE key = $1",
    [MEMORY_SERVICE_CONFIG_KEY],
  );
  if (!row) return undefined;
  try {
    return normalizeMemoryServiceConfig(JSON.parse(row.value_json) as MemoryServiceConfig);
  } catch {
    return undefined;
  }
}

export async function setMemoryServiceConfig(
  input: MemoryServiceConfig,
  client?: DatabaseClient,
): Promise<MemoryServiceConfig> {
  const config = normalizeMemoryServiceConfig(input);
  const database = client ?? await getDatabase();
  await database.execute(
    `INSERT INTO app_settings (key, value_json, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
    [MEMORY_SERVICE_CONFIG_KEY, JSON.stringify(config), Date.now()],
  );
  return config;
}

export async function getAffiliateCommerceConfig(
  client?: DatabaseClient,
): Promise<AffiliateCommerceConfig | undefined> {
  const database = client ?? await getDatabase();
  const [row] = await database.select<SettingRow[]>(
    "SELECT value_json FROM app_settings WHERE key = $1",
    [AFFILIATE_COMMERCE_CONFIG_KEY],
  );
  if (!row) return undefined;
  try {
    return normalizeAffiliateCommerceConfig(JSON.parse(row.value_json) as AffiliateCommerceConfig);
  } catch {
    return undefined;
  }
}

export async function setAffiliateCommerceConfig(
  input: AffiliateCommerceConfig,
  client?: DatabaseClient,
): Promise<AffiliateCommerceConfig> {
  const config = normalizeAffiliateCommerceConfig(input);
  const database = client ?? await getDatabase();
  await database.execute(
    `INSERT INTO app_settings (key, value_json, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
    [AFFILIATE_COMMERCE_CONFIG_KEY, JSON.stringify(config), Date.now()],
  );
  return config;
}

export function normalizeProviderProfile(
  input: ProviderProfileInput,
): ProviderProfileInput & { modelContextWindows: Record<string, number> } {
  const id = input.id.trim();
  const name = input.name.trim();
  const defaultModel = input.defaultModel.trim();
  const enabledModels = uniqueModels(input.enabledModels);
  const apiKeyRef = input.apiKeyRef.trim();
  if (!id || !name || !defaultModel || !apiKeyRef || enabledModels.length === 0) {
    throw new Error("Provider id, name, model and API Key reference are required");
  }
  if (!enabledModels.includes(defaultModel)) {
    throw new Error("Default model must be included in enabled models");
  }
  const modelContextWindows = normalizeModelContextWindows(
    input.modelContextWindows,
    enabledModels,
  );
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
    enabledModels,
    modelContextWindows,
    apiKeyRef,
  };
}

export function normalizeWebSearchConfig(input: WebSearchConfig): WebSearchConfig {
  if (input.provider !== "searxng") throw new Error("Unsupported web search provider");
  const apiKeyRef = input.apiKeyRef.trim();
  if (!apiKeyRef) throw new Error("联网搜索 API Key 引用不能为空");
  const url = new URL(input.baseUrl.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("联网搜索 URL 必须使用 HTTP 或 HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("联网搜索 URL 不能包含凭据、查询参数或片段");
  }
  return {
    provider: "searxng",
    baseUrl: url.toString().replace(/\/$/, ""),
    apiKeyRef,
    enabled: input.enabled,
  };
}

export function normalizeMemoryServiceConfig(input: MemoryServiceConfig): MemoryServiceConfig {
  if (input.provider !== "memos") throw new Error("Unsupported memory service provider");
  const userId = input.userId.trim();
  const apiKeyRef = input.apiKeyRef.trim();
  if (!userId || userId.length > 256) throw new Error("MemOS 用户标识不能为空且不能超过 256 个字符");
  if (!apiKeyRef) throw new Error("MemOS API Key 引用不能为空");
  const url = new URL(input.baseUrl.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MemOS URL 必须使用 HTTP 或 HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("MemOS URL 不能包含凭据、查询参数或片段");
  }
  return {
    provider: "memos",
    baseUrl: url.toString().replace(/\/$/, ""),
    userId,
    apiKeyRef,
    enabled: Boolean(input.enabled),
  };
}

export function normalizeAffiliateCommerceConfig(
  input: AffiliateCommerceConfig,
): AffiliateCommerceConfig {
  if (input.selectedProvider !== "jd" && input.selectedProvider !== "pdd") {
    throw new Error("不支持的电商返利平台");
  }
  const jd = input.jd ? {
    appKeyRef: requireSetting(input.jd.appKeyRef, "京东 App Key 引用"),
    secretKeyRef: requireSetting(input.jd.secretKeyRef, "京东 Secret Key 引用"),
    pid: requireSetting(input.jd.pid, "京东 PID"),
    siteId: requireDigits(input.jd.siteId, "京东网站 ID"),
    positionId: requireDigits(input.jd.positionId, "京东推广位 ID"),
  } : undefined;
  const pdd = input.pdd ? {
    clientIdRef: requireSetting(input.pdd.clientIdRef, "拼多多 Client ID 引用"),
    clientSecretRef: requireSetting(input.pdd.clientSecretRef, "拼多多 Client Secret 引用"),
    pid: requireSetting(input.pdd.pid, "拼多多 PID"),
  } : undefined;
  if (input.enabled && input.selectedProvider === "jd" && !jd) throw new Error("京东联盟配置不完整");
  if (input.enabled && input.selectedProvider === "pdd" && !pdd) throw new Error("拼多多联盟配置不完整");
  return {
    enabled: Boolean(input.enabled),
    selectedProvider: input.selectedProvider,
    ...(jd ? { jd } : {}),
    ...(pdd ? { pdd } : {}),
  };
}

function requireSetting(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(`${label}不能为空`);
  return normalized;
}

function requireDigits(value: string, label: string): string {
  const normalized = requireSetting(value, label);
  if (!/^\d+$/.test(normalized)) throw new Error(`${label}必须为数字`);
  return normalized;
}

function mapProviderProfile(row: ProviderProfileRow): ProviderProfile {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    defaultModel: row.default_model,
    enabledModels: parseModels(row.enabled_models_json, row.default_model),
    modelContextWindows: parseModelContextWindows(row.model_context_windows_json),
    apiKeyRef: row.api_key_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function uniqueModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function parseModels(json: string, fallback: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (Array.isArray(value)) {
      const models = uniqueModels(value.filter((item): item is string => typeof item === "string"));
      if (models.length) return models;
    }
  } catch {
    // Fall through to the legacy default model.
  }
  return [fallback];
}

export function resolveModelContextWindow(
  profile: Pick<ProviderProfile, "modelContextWindows"> | undefined,
  modelId: string | undefined,
): number {
  const configured = modelId ? profile?.modelContextWindows?.[modelId] : undefined;
  return normalizeContextWindow(configured) ?? DEFAULT_MODEL_CONTEXT_WINDOW;
}

function normalizeModelContextWindows(
  input: Record<string, number> | undefined,
  enabledModels: string[],
): Record<string, number> {
  return Object.fromEntries(
    enabledModels
      .map((model) => [
        model,
        normalizeContextWindow(input?.[model]) ?? DEFAULT_MODEL_CONTEXT_WINDOW,
      ] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function parseModelContextWindows(json: string): Record<string, number> {
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .map(([model, tokens]) => [model.trim(), normalizeContextWindow(tokens)] as const)
        .filter((entry): entry is readonly [string, number] =>
          Boolean(entry[0]) && entry[1] !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  } catch {
    return {};
  }
}

function normalizeContextWindow(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const tokens = Math.floor(value);
  return tokens >= MIN_MODEL_CONTEXT_WINDOW && tokens <= MAX_MODEL_CONTEXT_WINDOW
    ? tokens
    : undefined;
}
