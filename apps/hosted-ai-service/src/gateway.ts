import type { IncomingHttpHeaders } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServiceConfig } from "./config.js";
import { CommerceDomainError } from "./domain.js";
import type { PostgresCommerceRepository } from "./postgres.js";
import { verifyRunToken } from "./tokens.js";

const ALLOWED_PATHS = new Set([
  "/chat/completions",
  "/responses",
  "/images/generations",
  "/images/edits",
]);

export class HostedAiGateway {
  constructor(
    private readonly config: ServiceConfig,
    private readonly repository: Pick<PostgresCommerceRepository,
      "claimGatewayRequest" | "bindGatewayRequestModel" | "markGatewayRequestAccepted"
      | "ensureRunReservation" | "settleGatewayRequest" | "failGatewayRequest">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    gatewayPath: string,
  ): Promise<void> {
    if (request.method !== "POST" || !ALLOWED_PATHS.has(gatewayPath)) {
      throw new CommerceDomainError("gateway_route_not_allowed", "模型网关路由不可用", 404);
    }
    const bearer = authorizationToken(request.headers.authorization);
    const runId = verifyRunToken(bearer, this.config.runTokenSecret);
    if (!runId) throw new CommerceDomainError("invalid_run_token", "运行授权无效", 401);
    const claim = await this.repository.claimGatewayRequest(runId);
    const { run, gatewayRequestId } = claim;
    let upstreamAccepted = false;
    let model: ServiceConfig["models"][number] | undefined;

    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    try {
      const contentType = request.headers["content-type"] ?? "application/json";
      const body = await readBody(request, contentType.startsWith("multipart/form-data") ? 24 * 1024 * 1024 : 2 * 1024 * 1024);
      const modelId = requestedModelFromBody(body, contentType, run.modelId);
      model = this.config.models.find((candidate) => candidate.id === modelId);
      if (!model) throw new CommerceDomainError("model_unavailable", "当前模型不可用", 403);
      await this.repository.ensureRunReservation(run.id, model.reservePoints);
      await this.repository.bindGatewayRequestModel(gatewayRequestId, model.id);
      const upstreamBody = prepareBody(body, contentType, model.id, gatewayPath);
      const upstream = await this.fetchImpl(
        `${this.config.newApiBaseUrl}/v1${gatewayPath}`,
        {
          method: "POST",
          headers: upstreamHeaders(request.headers, contentType, this.config.newApiKey),
          body: upstreamBody,
          signal: controller.signal,
        },
      );
      if (!upstream.ok) {
        const payload = Buffer.from(await upstream.arrayBuffer());
        await this.repository.failGatewayRequest(gatewayRequestId);
        writeUpstreamResponse(response, upstream, payload);
        return;
      }
      await this.repository.markGatewayRequestAccepted(gatewayRequestId);
      upstreamAccepted = true;
      const upstreamType = upstream.headers.get("content-type") ?? "application/json";
      if (upstreamType.includes("text/event-stream") && upstream.body) {
        await this.pipeEventStream(gatewayRequestId, model, upstream, response);
        return;
      }
      const payload = Buffer.from(await upstream.arrayBuffer());
      const usage = extractUsageFromJson(payload, upstreamType);
      await this.repository.settleGatewayRequest(gatewayRequestId, model, usage);
      writeUpstreamResponse(response, upstream, payload);
    } catch (error) {
      if (!response.headersSent) {
        if (upstreamAccepted && model) {
          await this.repository.settleGatewayRequest(gatewayRequestId, model).catch(() => undefined);
        } else {
          await this.repository.failGatewayRequest(gatewayRequestId).catch(() => undefined);
        }
      }
      throw error;
    }
  }

  private async pipeEventStream(
    gatewayRequestId: string,
    model: ServiceConfig["models"][number],
    upstream: Response,
    response: ServerResponse,
  ): Promise<void> {
    response.writeHead(upstream.status, publicHeaders(upstream.headers));
    const decoder = new TextDecoder();
    let lineBuffer = "";
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    try {
      const reader = upstream.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = value;
        response.write(Buffer.from(bytes));
        lineBuffer += decoder.decode(bytes, { stream: true });
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) usage = extractUsageFromSseLine(line) ?? usage;
      }
      lineBuffer += decoder.decode();
      usage = extractUsageFromSseLine(lineBuffer) ?? usage;
      await this.repository.settleGatewayRequest(gatewayRequestId, model, usage);
      response.end();
    } catch (error) {
      await this.repository.settleGatewayRequest(gatewayRequestId, model).catch(() => undefined);
      response.destroy(error instanceof Error ? error : new Error("模型流传输失败"));
    }
  }
}

export function requestedModelFromBody(
  body: Buffer,
  contentType: string,
  defaultModelId: string,
): string {
  if (contentType.startsWith("multipart/form-data")) {
    const values = multipartFieldValues(body, contentType, "model");
    if (values.length !== 1 || !values[0]?.trim()) {
      throw new CommerceDomainError("invalid_model", "生图请求必须包含一个有效模型", 400);
    }
    return values[0].trim();
  }
  const object = parseJsonObject(body);
  if (object.model === undefined) return defaultModelId;
  if (typeof object.model !== "string" || !object.model.trim()) {
    throw new CommerceDomainError("invalid_model", "模型标识无效", 400);
  }
  return object.model.trim();
}

function authorizationToken(value: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(value ?? "");
  if (!match?.[1]) throw new CommerceDomainError("missing_run_token", "缺少运行授权", 401);
  return match[1].trim();
}

async function readBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maximum) throw new CommerceDomainError("request_too_large", "模型请求体过大", 413);
    chunks.push(buffer);
  }
  if (!bytes) throw new CommerceDomainError("empty_gateway_request", "模型请求体不能为空", 400);
  return Buffer.concat(chunks);
}

export function prepareBody(body: Buffer, contentType: string, modelId: string, path: string): BodyInit {
  if (contentType.startsWith("multipart/form-data")) {
    const modelValues = multipartFieldValues(body, contentType, "model");
    if (modelValues.length !== 1 || modelValues[0] !== modelId) {
      throw new CommerceDomainError("model_mismatch", "生图请求模型与运行授权不匹配", 403);
    }
    const bytes = new Uint8Array(body.byteLength);
    bytes.set(body);
    return bytes;
  }
  const object = parseJsonObject(body);
  object.model = modelId;
  if (path === "/chat/completions" && object.stream === true) {
    const streamOptions = object.stream_options && typeof object.stream_options === "object"
      ? object.stream_options as Record<string, unknown>
      : {};
    object.stream_options = { ...streamOptions, include_usage: true };
  }
  return JSON.stringify(object);
}

function parseJsonObject(body: Buffer): Record<string, unknown> {
  let payload: unknown;
  try { payload = JSON.parse(body.toString("utf8")); } catch {
    throw new CommerceDomainError("invalid_gateway_json", "模型请求不是有效 JSON", 400);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CommerceDomainError("invalid_gateway_json", "模型请求必须是 JSON 对象", 400);
  }
  return payload as Record<string, unknown>;
}

function multipartFieldValues(body: Buffer, contentType: string, fieldName: string): string[] {
  const boundaryMatch = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary || boundary.length > 200) {
    throw new CommerceDomainError("invalid_multipart", "生图请求缺少有效 multipart boundary", 400);
  }
  const marker = `--${boundary}`;
  const values: string[] = [];
  for (const rawPart of body.toString("latin1").split(marker).slice(1)) {
    if (rawPart.startsWith("--")) break;
    const part = rawPart.replace(/^\r?\n/, "");
    const separator = part.indexOf("\r\n\r\n");
    const fallbackSeparator = separator < 0 ? part.indexOf("\n\n") : -1;
    const headerEnd = separator >= 0 ? separator : fallbackSeparator;
    if (headerEnd < 0) continue;
    const separatorLength = separator >= 0 ? 4 : 2;
    const headers = part.slice(0, headerEnd);
    const disposition = headers.split(/\r?\n/).find((line) => /^content-disposition:/i.test(line));
    if (!disposition) continue;
    const name = /(?:^|;)\s*name="([^"]+)"/i.exec(disposition)?.[1];
    if (name !== fieldName) continue;
    values.push(part.slice(headerEnd + separatorLength).replace(/\r?\n$/, ""));
  }
  return values;
}

function upstreamHeaders(
  incoming: IncomingHttpHeaders,
  contentType: string,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": contentType,
    Accept: typeof incoming.accept === "string" ? incoming.accept : "application/json",
    "Accept-Encoding": "identity",
  };
  const userAgent = incoming["user-agent"];
  if (typeof userAgent === "string") headers["User-Agent"] = userAgent.slice(0, 300);
  return headers;
}

function extractUsageFromJson(
  payload: Buffer,
  contentType: string,
): { inputTokens: number; outputTokens: number } | undefined {
  if (!contentType.includes("json")) return undefined;
  try { return findUsage(JSON.parse(payload.toString("utf8"))); } catch { return undefined; }
}

export function extractUsageFromSseLine(line: string): { inputTokens: number; outputTokens: number } | undefined {
  if (!line.startsWith("data:")) return undefined;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return undefined;
  try { return findUsage(JSON.parse(data)); } catch { return undefined; }
}

export function findUsage(value: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  const usage = object.usage && typeof object.usage === "object"
    ? object.usage as Record<string, unknown>
    : object.response && typeof object.response === "object"
      ? (object.response as Record<string, unknown>).usage as Record<string, unknown> | undefined
      : undefined;
  if (!usage) return undefined;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  if (!Number.isSafeInteger(input) || (input as number) < 0
    || !Number.isSafeInteger(output) || (output as number) < 0) return undefined;
  return { inputTokens: input as number, outputTokens: output as number };
}

function writeUpstreamResponse(response: ServerResponse, upstream: Response, payload: Buffer): void {
  response.writeHead(upstream.status, publicHeaders(upstream.headers));
  response.end(payload);
}

function publicHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  for (const key of ["content-type", "x-request-id"] as const) {
    const value = headers.get(key);
    if (value) output[key] = value;
  }
  return output;
}
