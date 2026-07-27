export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_CHAT_IMAGES_TOTAL_BYTES = 20 * 1024 * 1024;
export const CHAT_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export interface ChatImageAttachment {
  id: string;
  name: string;
  mediaType: (typeof CHAT_IMAGE_MEDIA_TYPES)[number];
  bytes: number;
  path?: string;
  data?: string;
}

export interface MultimodalChatContent {
  type: "multimodal";
  text: string;
  images: ChatImageAttachment[];
}

export interface AssistantChatContent {
  type: "assistant";
  text: string;
  reasoning: string;
  references?: ChatWebReference[];
  failed?: true;
}

export interface ChatWebReference {
  title: string;
  url: string;
  snippet?: string;
  engine?: string;
}

export function createChatMessageContent(
  text: string,
  images: ChatImageAttachment[] = [],
): string | MultimodalChatContent {
  const normalizedText = text.trim();
  if (!images.length) return normalizedText;
  return { type: "multimodal", text: normalizedText, images: [...images] };
}

export function createAssistantMessageContent(
  text: string,
  reasoning = "",
  references: ChatWebReference[] = [],
): string | AssistantChatContent {
  const normalizedText = text.trim();
  const normalizedReasoning = reasoning.trim();
  const normalizedReferences = normalizeChatWebReferences(references);
  if (!normalizedReasoning && !normalizedReferences.length) return normalizedText;
  return {
    type: "assistant",
    text: normalizedText,
    reasoning: normalizedReasoning,
    ...(normalizedReferences.length ? { references: normalizedReferences } : {}),
  };
}

export function createAssistantFailureContent(message: string): AssistantChatContent {
  return {
    type: "assistant",
    text: message.trim() || "Flow 执行失败",
    reasoning: "",
    failed: true,
  };
}

export function chatMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  return readMultimodalChatContent(content)?.text ?? readAssistantChatContent(content)?.text ?? "";
}

export function chatMessageFailed(content: unknown): boolean {
  return readAssistantChatContent(content)?.failed === true;
}

export function chatMessageReasoning(content: unknown): string {
  return readAssistantChatContent(content)?.reasoning ?? "";
}

export function chatMessageReferences(content: unknown): ChatWebReference[] {
  return readAssistantChatContent(content)?.references ?? [];
}

export function chatMessageImages(content: unknown): ChatImageAttachment[] {
  return readMultimodalChatContent(content)?.images ?? [];
}

export function chatMessageSummary(content: unknown): string {
  const text = chatMessageText(content).trim();
  const images = chatMessageImages(content);
  const labels = images.map((image) => `[图片：${image.name}]`).join(" ");
  return [text, labels].filter(Boolean).join("\n");
}

export function chatImageDataUrl(image: ChatImageAttachment): string {
  return image.data ? `data:${image.mediaType};base64,${image.data}` : "";
}

export async function filesToChatImages(
  files: Iterable<File>,
  existing: ChatImageAttachment[] = [],
): Promise<ChatImageAttachment[]> {
  const selected = [...files];
  if (existing.length + selected.length > MAX_CHAT_IMAGES) {
    throw new Error(`每条消息最多上传 ${MAX_CHAT_IMAGES} 张图片`);
  }
  let totalBytes = existing.reduce((sum, image) => sum + image.bytes, 0);
  const images: ChatImageAttachment[] = [];
  for (const file of selected) {
    if (!CHAT_IMAGE_MEDIA_TYPES.includes(file.type as ChatImageAttachment["mediaType"])) {
      throw new Error("聊天图片仅支持 PNG、JPEG 或 WebP");
    }
    if (!file.size) throw new Error(`图片“${file.name || "未命名"}”为空`);
    if (file.size > MAX_CHAT_IMAGE_BYTES) {
      throw new Error(`图片“${file.name || "未命名"}”不能超过 8 MB`);
    }
    totalBytes += file.size;
    if (totalBytes > MAX_CHAT_IMAGES_TOTAL_BYTES) {
      throw new Error("单条消息的图片总大小不能超过 20 MB");
    }
    images.push({
      id: crypto.randomUUID(),
      name: (file.name.trim() || "image").slice(0, 120),
      mediaType: file.type as ChatImageAttachment["mediaType"],
      data: arrayBufferToBase64(await file.arrayBuffer()),
      bytes: file.size,
    });
  }
  return images;
}

function readMultimodalChatContent(content: unknown): MultimodalChatContent | undefined {
  if (!content || typeof content !== "object") return undefined;
  const candidate = content as { type?: unknown; text?: unknown; images?: unknown };
  if (candidate.type !== "multimodal" || typeof candidate.text !== "string" || !Array.isArray(candidate.images)) {
    return undefined;
  }
  const images = candidate.images.filter(isChatImageAttachment);
  return { type: "multimodal", text: candidate.text, images };
}

function readAssistantChatContent(content: unknown): AssistantChatContent | undefined {
  if (!content || typeof content !== "object") return undefined;
  const candidate = content as {
    type?: unknown;
    text?: unknown;
    reasoning?: unknown;
    references?: unknown;
    failed?: unknown;
  };
  if (candidate.type !== "assistant"
    || typeof candidate.text !== "string"
    || typeof candidate.reasoning !== "string") {
    return undefined;
  }
  const references = Array.isArray(candidate.references)
    ? normalizeChatWebReferences(candidate.references)
    : [];
  return {
    type: "assistant",
    text: candidate.text,
    reasoning: candidate.reasoning,
    ...(references.length ? { references } : {}),
    ...(candidate.failed === true ? { failed: true } : {}),
  };
}

function normalizeChatWebReferences(values: unknown[]): ChatWebReference[] {
  const references: ChatWebReference[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const candidate = value as Partial<ChatWebReference>;
    const title = typeof candidate.title === "string" ? candidate.title.trim().slice(0, 180) : "";
    const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
    if (!title || !isSafeWebUrl(url) || seen.has(url)) continue;
    seen.add(url);
    const snippet = typeof candidate.snippet === "string" ? candidate.snippet.trim().slice(0, 320) : "";
    const engine = typeof candidate.engine === "string" ? candidate.engine.trim().slice(0, 40) : "";
    references.push({
      title,
      url,
      ...(snippet ? { snippet } : {}),
      ...(engine ? { engine } : {}),
    });
    if (references.length >= 6) break;
  }
  return references;
}

function isSafeWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isChatImageAttachment(value: unknown): value is ChatImageAttachment {
  if (!value || typeof value !== "object") return false;
  const image = value as Partial<ChatImageAttachment>;
  const hasStoredPath = typeof image.path === "string" && isChatImagePath(image.path);
  const hasLegacyData = typeof image.data === "string" && image.data.length > 0;
  return typeof image.id === "string"
    && typeof image.name === "string"
    && typeof image.bytes === "number"
    && image.bytes > 0
    && (hasStoredPath || hasLegacyData)
    && CHAT_IMAGE_MEDIA_TYPES.includes(image.mediaType as ChatImageAttachment["mediaType"]);
}

export function isChatImagePath(value: string): boolean {
  return /^chat-images\/[A-Za-z0-9-]{1,80}\.(?:png|jpg|webp)$/.test(value);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}
