export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_CHAT_IMAGES_TOTAL_BYTES = 20 * 1024 * 1024;
export const CHAT_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export interface ChatImageAttachment {
  id: string;
  name: string;
  mediaType: (typeof CHAT_IMAGE_MEDIA_TYPES)[number];
  data: string;
  bytes: number;
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
}

export function createChatMessageContent(
  text: string,
  images: ChatImageAttachment[] = [],
): string | MultimodalChatContent {
  const normalizedText = text.trim();
  if (!images.length) return normalizedText;
  return { type: "multimodal", text: normalizedText, images: [...images] };
}

export function createAssistantMessageContent(text: string, reasoning = ""): string | AssistantChatContent {
  const normalizedText = text.trim();
  const normalizedReasoning = reasoning.trim();
  if (!normalizedReasoning) return normalizedText;
  return { type: "assistant", text: normalizedText, reasoning: normalizedReasoning };
}

export function chatMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  return readMultimodalChatContent(content)?.text ?? readAssistantChatContent(content)?.text ?? "";
}

export function chatMessageReasoning(content: unknown): string {
  return readAssistantChatContent(content)?.reasoning ?? "";
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
  return `data:${image.mediaType};base64,${image.data}`;
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
  const candidate = content as { type?: unknown; text?: unknown; reasoning?: unknown };
  if (candidate.type !== "assistant"
    || typeof candidate.text !== "string"
    || typeof candidate.reasoning !== "string") {
    return undefined;
  }
  return { type: "assistant", text: candidate.text, reasoning: candidate.reasoning };
}

function isChatImageAttachment(value: unknown): value is ChatImageAttachment {
  if (!value || typeof value !== "object") return false;
  const image = value as Partial<ChatImageAttachment>;
  return typeof image.id === "string"
    && typeof image.name === "string"
    && typeof image.data === "string"
    && typeof image.bytes === "number"
    && image.bytes > 0
    && CHAT_IMAGE_MEDIA_TYPES.includes(image.mediaType as ChatImageAttachment["mediaType"]);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}
