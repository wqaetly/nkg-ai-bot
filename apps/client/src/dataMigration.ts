import { invoke } from "@tauri-apps/api/core";
import { isChatImagePath } from "./chatContent";
import {
  listStoredChatImagePaths,
  migrateLegacyChatImages,
} from "./chatImageStore";
import { getDatabase } from "./storage/database";

export const MIGRATION_FORMAT = "nkg-ai-bot-portable-backup";
export const MIGRATION_VERSION = 2;
const LOCAL_STORAGE_PREFIX = "nkg.";

export interface MigrationChatImage {
  path: string;
  data: string;
}

interface NativeSnapshot {
  databaseHex?: string | null;
  vaultHex?: string | null;
  deviceKeyHex?: string | null;
  strongholdSaltHex?: string | null;
  chatImages?: MigrationChatImage[];
}

export interface MigrationCounts {
  conversations: number;
  messages: number;
  images: number;
  skills: number;
  memories: number;
}

export interface AppMigrationBundle {
  format: typeof MIGRATION_FORMAT;
  version: number;
  exportedAt: string;
  counts: MigrationCounts;
  preferences: Record<string, string>;
  snapshot: Required<Pick<NativeSnapshot, "databaseHex">> & NativeSnapshot;
}

export async function createMigrationBundle(
  storage: Pick<Storage, "length" | "key" | "getItem"> = localStorage,
): Promise<AppMigrationBundle> {
  await migrateLegacyChatImages();
  const database = await getDatabase();
  await database.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  const chatImagePaths = await listStoredChatImagePaths(database);
  const [snapshot, counts] = await Promise.all([
    invoke<NativeSnapshot>("export_app_snapshot", { chatImagePaths }),
    readCounts(),
  ]);
  if (!isHex(snapshot.databaseHex)) throw new Error("无法读取应用数据库，请稍后重试");
  const chatImages = normalizeMigrationChatImages(snapshot.chatImages);
  return {
    format: MIGRATION_FORMAT,
    version: MIGRATION_VERSION,
    exportedAt: new Date().toISOString(),
    counts: { ...counts, images: chatImages.length },
    preferences: readPortablePreferences(storage),
    snapshot: {
      databaseHex: snapshot.databaseHex,
      vaultHex: optionalHex(snapshot.vaultHex),
      deviceKeyHex: optionalHex(snapshot.deviceKeyHex),
      strongholdSaltHex: optionalHex(snapshot.strongholdSaltHex),
      chatImages,
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
  if (candidate.version !== MIGRATION_VERSION) {
    throw new Error(`暂不支持迁移包版本 ${String(candidate.version)}`);
  }
  if (!candidate.snapshot || !isHex(candidate.snapshot.databaseHex)) throw new Error("迁移包缺少有效的聊天数据库");
  validateOptionalHex(candidate.snapshot.vaultHex, "Stronghold 快照");
  validateOptionalHex(candidate.snapshot.deviceKeyHex, "设备密钥");
  validateOptionalHex(candidate.snapshot.strongholdSaltHex, "Stronghold 盐值");
  const chatImages = normalizeMigrationChatImages(candidate.snapshot.chatImages);
  if (!candidate.preferences || typeof candidate.preferences !== "object" || Array.isArray(candidate.preferences)) {
    throw new Error("迁移包缺少应用偏好");
  }
  const preferences = Object.fromEntries(Object.entries(candidate.preferences).filter(
    ([key, item]) => key.startsWith(LOCAL_STORAGE_PREFIX) && typeof item === "string",
  ));
  const counts = normalizeCounts(candidate.counts);
  return {
    ...candidate,
    counts: { ...counts, images: chatImages.length },
    preferences,
    snapshot: { ...candidate.snapshot, chatImages },
  } as AppMigrationBundle;
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
    chatImages: bundle.snapshot.chatImages ?? [],
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
    images: safeCount(counts.images),
    skills: safeCount(counts.skills),
    memories: safeCount(counts.memories),
  };
}

function normalizeMigrationChatImages(value: unknown): MigrationChatImage[] {
  if (!Array.isArray(value)) throw new Error("迁移包缺少聊天图片文件");
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("迁移包包含无效的聊天图片");
    const candidate = item as Partial<MigrationChatImage>;
    if (typeof candidate.path !== "string" || !isChatImagePath(candidate.path)) {
      throw new Error("迁移包包含不安全的聊天图片路径");
    }
    if (seen.has(candidate.path)) throw new Error("迁移包包含重复的聊天图片路径");
    if (typeof candidate.data !== "string" || !isBase64(candidate.data)) {
      throw new Error(`聊天图片 ${candidate.path} 数据损坏`);
    }
    seen.add(candidate.path);
    return { path: candidate.path, data: candidate.data };
  });
}

function isBase64(value: string): boolean {
  return value.length > 0
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
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
