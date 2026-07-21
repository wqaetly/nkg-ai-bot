export const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export const IMAGE_QUALITIES = ["low", "medium", "high", "auto"] as const;
export const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;

export type ImageSize = (typeof IMAGE_SIZES)[number];
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

export interface ReferenceImage {
  blob: Blob;
  fileName: string;
}

export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  size: ImageSize;
  quality: ImageQuality;
  referenceImage?: ReferenceImage;
  signal?: AbortSignal;
}

export interface ImageGenerationResult {
  src: string;
  revisedPrompt?: string;
  model: string;
  size: ImageSize;
  quality: ImageQuality;
  mode: "generation" | "edit";
}

/**
 * Calls the OpenAI-compatible image endpoint. The API key remains scoped to
 * this one request and is never included in the returned result or errors.
 */
export async function requestImageGeneration(
  baseUrl: string,
  apiKey: string,
  request: ImageGenerationRequest,
  fetchImpl: typeof globalThis.fetch,
): Promise<ImageGenerationResult> {
  const prompt = request.prompt.trim();
  const model = request.model.trim();
  if (!prompt) throw new Error("请输入生图描述");
  if (!model) throw new Error("请选择生图模型");
  if (!IMAGE_SIZES.includes(request.size)) throw new Error("不支持的图片尺寸");
  if (!IMAGE_QUALITIES.includes(request.quality)) throw new Error("不支持的图片质量");
  validateReferenceImage(request.referenceImage);

  const mode = request.referenceImage ? "edit" : "generation";
  const endpoint = imageEndpoint(baseUrl, mode);
  const init = request.referenceImage
    ? editRequestInit(apiKey, request, prompt, model)
    : generationRequestInit(apiKey, request, prompt, model);
  const response = await fetchImpl(endpoint, init);
  if (!response.ok) {
    const detail = await readProviderError(response, apiKey);
    throw new Error(`生图请求失败：HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
  }

  const payload = await response.json() as unknown;
  const item = firstImageItem(payload);
  const src = typeof item.b64_json === "string" && item.b64_json
    ? `data:image/png;base64,${item.b64_json}`
    : safeResultUrl(item.url);
  if (!src) throw new Error("生图接口返回成功，但没有可用的图片数据");

  return {
    src,
    model,
    size: request.size,
    quality: request.quality,
    mode,
    ...(typeof item.revised_prompt === "string" && item.revised_prompt.trim()
      ? { revisedPrompt: item.revised_prompt.trim() }
      : {}),
  };
}

function generationRequestInit(
  apiKey: string,
  request: ImageGenerationRequest,
  prompt: string,
  model: string,
): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size: request.size,
      quality: request.quality,
      response_format: "b64_json",
    }),
    signal: request.signal,
  };
}

function editRequestInit(
  apiKey: string,
  request: ImageGenerationRequest,
  prompt: string,
  model: string,
): RequestInit {
  const reference = request.referenceImage!;
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("image", reference.blob, reference.fileName || "reference.png");
  form.set("n", "1");
  form.set("size", request.size);
  form.set("quality", request.quality);
  form.set("response_format", "b64_json");
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      Accept: "application/json",
    },
    body: form,
    signal: request.signal,
  };
}

function imageEndpoint(baseUrl: string, mode: "generation" | "edit"): URL {
  const endpoint = new URL(baseUrl.trim());
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("生图 API URL 必须使用 HTTP 或 HTTPS");
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/images/${mode === "edit" ? "edits" : "generations"}`;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function validateReferenceImage(reference?: ReferenceImage): void {
  if (!reference) return;
  if (!reference.blob.size) throw new Error("参考图片为空");
  if (reference.blob.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error("参考图片不能超过 20 MB");
  }
  const type = reference.blob.type.toLowerCase();
  if (type && !["image/png", "image/jpeg", "image/webp"].includes(type)) {
    throw new Error("参考图片仅支持 PNG、JPEG 或 WebP");
  }
}

async function readProviderError(response: Response, apiKey: string): Promise<string> {
  try {
    const payload = await response.json() as unknown;
    if (payload && typeof payload === "object") {
      const error = (payload as { error?: unknown }).error;
      const message = error && typeof error === "object"
        ? (error as { message?: unknown }).message
        : undefined;
      if (typeof message === "string" && message.trim()) {
        const secret = apiKey.trim();
        const sanitized = secret ? message.split(secret).join("[redacted]") : message;
        return sanitized.trim().slice(0, 300);
      }
    }
  } catch {
    // Status code remains actionable when the provider body is not JSON.
  }
  return "";
}

function firstImageItem(payload: unknown): {
  b64_json?: unknown;
  url?: unknown;
  revised_prompt?: unknown;
} {
  if (!payload || typeof payload !== "object") return {};
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || !data[0] || typeof data[0] !== "object") return {};
  return data[0] as { b64_json?: unknown; url?: unknown; revised_prompt?: unknown };
}

function safeResultUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}
