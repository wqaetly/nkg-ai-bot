import { invoke } from "@tauri-apps/api/core";
import { getDatabase } from "./storage/database";

export const MIGRATION_FORMAT = "nkg-ai-bot-portable-backup";
export const MIGRATION_VERSION = 1;
const LOCAL_STORAGE_PREFIX = "nkg.";

interface NativeSnapshot {
  databaseHex?: string | null;
  vaultHex?: string | null;
  deviceKeyHex?: string | null;
  strongholdSaltHex?: string | null;
}

export interface MigrationCounts {
  conversations: number;
  messages: number;
  skills: number;
  memories: number;
}

export interface AppMigrationBundle {
  format: typeof MIGRATION_FORMAT;
  version: typeof MIGRATION_VERSION;
  exportedAt: string;
  counts: MigrationCounts;
  preferences: Record<string, string>;
  snapshot: Required<Pick<NativeSnapshot, "databaseHex">> & NativeSnapshot;
}

export async function createMigrationBundle(
  storage: Pick<Storage, "length" | "key" | "getItem"> = localStorage,
): Promise<AppMigrationBundle> {
  const database = await getDatabase();
  await database.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  const [snapshot, counts] = await Promise.all([
    invoke<NativeSnapshot>("export_app_snapshot"),
    readCounts(),
  ]);
  if (!isHex(snapshot.databaseHex)) throw new Error("无法读取应用数据库，请稍后重试");
  return {
    format: MIGRATION_FORMAT,
    version: MIGRATION_VERSION,
    exportedAt: new Date().toISOString(),
    counts,
    preferences: readPortablePreferences(storage),
    snapshot: {
      databaseHex: snapshot.databaseHex,
      vaultHex: optionalHex(snapshot.vaultHex),
      deviceKeyHex: optionalHex(snapshot.deviceKeyHex),
      strongholdSaltHex: optionalHex(snapshot.strongholdSaltHex),
    },
  };
}

export function parseMigrationBundle(text: string): AppMigrationBundle {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("这不是有效的 NKG 迁移文件");
  }
  if (!value || typeof value !== "object") throw new Error("迁移文件内容无效");
  const candidate = value as Partial<AppMigrationBundle>;
  if (candidate.format !== MIGRATION_FORMAT) throw new Error("文件不是 NKG 应用迁移包");
  if (candidate.version !== MIGRATION_VERSION) throw new Error(`暂不支持迁移包版本 ${String(candidate.version)}`);
  if (!candidate.snapshot || !isHex(candidate.snapshot.databaseHex)) throw new Error("迁移包缺少有效的聊天数据库");
  validateOptionalHex(candidate.snapshot.vaultHex, "Stronghold 快照");
  validateOptionalHex(candidate.snapshot.deviceKeyHex, "设备密钥");
  validateOptionalHex(candidate.snapshot.strongholdSaltHex, "Stronghold 盐值");
  if (!candidate.preferences || typeof candidate.preferences !== "object" || Array.isArray(candidate.preferences)) {
    throw new Error("迁移包缺少应用偏好");
  }
  const preferences = Object.fromEntries(Object.entries(candidate.preferences).filter(
    ([key, item]) => key.startsWith(LOCAL_STORAGE_PREFIX) && typeof item === "string",
  ));
  const counts = normalizeCounts(candidate.counts);
  return { ...candidate, counts, preferences } as AppMigrationBundle;
}

export async function stageMigrationBundle(
  bundle: AppMigrationBundle,
  storage: Pick<Storage, "length" | "key" | "removeItem" | "setItem"> = localStorage,
): Promise<void> {
  writePortablePreferences(bundle.preferences, storage);
  await invoke("stage_app_import", {
    databaseHex: bundle.snapshot.databaseHex,
    vaultHex: bundle.snapshot.vaultHex ?? null,
    deviceKeyHex: bundle.snapshot.deviceKeyHex ?? null,
    strongholdSaltHex: bundle.snapshot.strongholdSaltHex ?? null,
  });
}

export function restartAfterImport(): void {
  void invoke("restart_app");
}

export async function downloadMigrationBundle(bundle: AppMigrationBundle, prefix = "nkg-ai-bot-backup"): Promise<string> {
  const date = bundle.exportedAt.replace(/[:.]/g, "-");
  return invoke<string>("save_migration_bundle", {
    contents: JSON.stringify(bundle),
    filename: `${prefix}-${date}.nkgbackup`,
  });
}

function readPortablePreferences(storage: Pick<Storage, "length" | "key" | "getItem">): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(LOCAL_STORAGE_PREFIX)) continue;
    const value = storage.getItem(key);
    if (value !== null) result[key] = value;
  }
  return result;
}

function writePortablePreferences(
  preferences: Record<string, string>,
  storage: Pick<Storage, "length" | "key" | "removeItem" | "setItem">,
): void {
  const existing: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(LOCAL_STORAGE_PREFIX)) existing.push(key);
  }
  existing.forEach((key) => storage.removeItem(key));
  Object.entries(preferences).forEach(([key, value]) => storage.setItem(key, value));
}

async function readCounts(): Promise<MigrationCounts> {
  const database = await getDatabase();
  const rows = await database.select<Array<{
    conversations: number;
    messages: number;
    skills: number;
    memories: number;
  }>>(`SELECT
    (SELECT COUNT(*) FROM conversations) AS conversations,
    (SELECT COUNT(*) FROM messages) AS messages,
    (SELECT COUNT(*) FROM assistant_versions) AS skills,
    (SELECT COUNT(*) FROM memory_items) AS memories`);
  return normalizeCounts(rows[0]);
}

function normalizeCounts(value: unknown): MigrationCounts {
  const counts = value && typeof value === "object" ? value as Partial<MigrationCounts> : {};
  return {
    conversations: safeCount(counts.conversations),
    messages: safeCount(counts.messages),
    skills: safeCount(counts.skills),
    memories: safeCount(counts.memories),
  };
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function optionalHex(value: string | null | undefined): string | null {
  return isHex(value) ? value : null;
}

function validateOptionalHex(value: unknown, label: string): void {
  if (value !== null && value !== undefined && !isHex(value)) throw new Error(`${label}数据损坏`);
}

function isHex(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}
