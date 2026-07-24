import { invoke } from "@tauri-apps/api/core";
import {
  chatImageDataUrl,
  chatMessageImages,
  isChatImagePath,
  type ChatImageAttachment,
} from "./chatContent";
import { getDatabase, type DatabaseClient } from "./storage/database";

interface NativeStoredChatImage {
  id: string;
  path: string;
}

interface MessageContentRow {
  id: string;
  content_json: string;
}

export interface ChatImageStore {
  persist(images: ChatImageAttachment[]): Promise<ChatImageAttachment[]>;
  readBase64(image: ChatImageAttachment): Promise<string>;
  delete(paths: string[]): Promise<void>;
}

const imageDataUrlCache = new Map<string, Promise<string>>();

export const nativeChatImageStore: ChatImageStore = {
  async persist(images) {
    const pending = images.filter((image) => !image.path);
    if (!pending.length) return images.map(stripInlineData);
    if (pending.some((image) => !image.data)) {
      throw new Error("聊天图片数据不完整，请重新选择图片");
    }
    const stored = await invoke<NativeStoredChatImage[]>("save_chat_images", {
      images: pending.map((image) => ({
        id: image.id,
        mediaType: image.mediaType,
        data: image.data,
        bytes: image.bytes,
      })),
    });
    const paths = new Map(stored.map((image) => [image.id, image.path]));
    return images.map((image) => {
      const path = image.path ?? paths.get(image.id);
      if (!path || !isChatImagePath(path)) throw new Error(`图片“${image.name}”保存失败`);
      return stripInlineData({ ...image, path });
    });
  },

  async readBase64(image) {
    if (image.data) return image.data;
    if (!image.path || !isChatImagePath(image.path)) throw new Error(`图片“${image.name}”路径无效`);
    return invoke<string>("read_chat_image", { path: image.path });
  },

  async delete(paths) {
    const unique = [...new Set(paths.filter(isChatImagePath))];
    if (unique.length) await invoke("delete_chat_images", { paths: unique });
  },
};

export async function loadChatImageDataUrl(image: ChatImageAttachment): Promise<string> {
  const inline = chatImageDataUrl(image);
  if (inline) return inline;
  if (!image.path) throw new Error(`图片“${image.name}”路径缺失`);
  let cached = imageDataUrlCache.get(image.path);
  if (!cached) {
    cached = nativeChatImageStore.readBase64(image)
      .then((data) => `data:${image.mediaType};base64,${data}`)
      .catch((error: unknown) => {
        imageDataUrlCache.delete(image.path!);
        throw error;
      });
    imageDataUrlCache.set(image.path, cached);
  }
  return cached;
}

export async function deleteStoredChatImages(images: ChatImageAttachment[]): Promise<void> {
  const paths = images.flatMap((image) => image.path ? [image.path] : []);
  await nativeChatImageStore.delete(paths);
  paths.forEach((path) => imageDataUrlCache.delete(path));
}

export async function listStoredChatImagePaths(client?: DatabaseClient): Promise<string[]> {
  const database = client ?? await getDatabase();
  const rows = await database.select<MessageContentRow[]>(
    "SELECT id, content_json FROM messages WHERE content_json LIKE '%\"images\"%'",
  );
  const paths = rows.flatMap((row) => {
    try {
      return chatMessageImages(JSON.parse(row.content_json) as unknown)
        .flatMap((image) => image.path ? [image.path] : []);
    } catch {
      return [];
    }
  });
  return [...new Set(paths)].sort();
}

export async function migrateLegacyChatImages(client?: DatabaseClient): Promise<number> {
  const database = client ?? await getDatabase();
  const rows = await database.select<MessageContentRow[]>(
    "SELECT id, content_json FROM messages WHERE content_json LIKE '%\"type\":\"multimodal\"%'",
  );
  let migrated = 0;
  for (const row of rows) {
    let content: unknown;
    try {
      content = JSON.parse(row.content_json) as unknown;
    } catch {
      continue;
    }
    const images = chatMessageImages(content);
    if (!images.some((image) => !image.path && image.data)) continue;
    const stored = await nativeChatImageStore.persist(images);
    const candidate = content as { type?: unknown; images?: unknown };
    await database.execute(
      "UPDATE messages SET content_json=$2 WHERE id=$1",
      [row.id, JSON.stringify({ ...candidate, images: stored })],
    );
    migrated += stored.filter((image) => image.path).length;
  }
  return migrated;
}

function stripInlineData(image: ChatImageAttachment): ChatImageAttachment {
  const { data: _data, ...stored } = image;
  return stored;
}
