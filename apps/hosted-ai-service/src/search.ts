import type { ServiceConfig } from "./config.js";
import { CommerceDomainError } from "./domain.js";
import type { PostgresCommerceRepository } from "./postgres.js";

const MAX_RESPONSE_BYTES = 1_000_000;

export interface HostedSearchResult {
  title: string;
  url: string;
  content: string;
  engine?: string;
}

export class HostedSearxngSearch {
  constructor(
    private readonly config: Pick<ServiceConfig,
      "searxngBaseUrl" | "searxngApiKey" | "searchTimeoutMs" | "searchMaxResults">,
    private readonly repository: Pick<PostgresCommerceRepository, "authenticateSession">,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async search(sessionToken: string, input: unknown): Promise<HostedSearchResult[]> {
    await this.repository.authenticateSession(sessionToken);
    const body = requireObject(input);
    const query = requireQuery(body.query);
    const requestedLimit = body.maxResults === undefined
      ? this.config.searchMaxResults
      : requireLimit(body.maxResults);
    const limit = Math.min(requestedLimit, this.config.searchMaxResults);
    const endpoint = new URL(this.config.searxngBaseUrl);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/search`;
    endpoint.search = "";
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    endpoint.hash = "";

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "GET",
        headers: {
          "X-API-Key": this.config.searxngApiKey,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(this.config.searchTimeoutMs),
      });
    } catch (cause: unknown) {
      if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
        throw new CommerceDomainError("search_timeout", "联网搜索超时，请稍后重试", 504);
      }
      throw new CommerceDomainError("search_unavailable", "联网搜索暂时不可用，请稍后重试", 502);
    }
    if (!response.ok) {
      throw new CommerceDomainError("search_upstream_error", "联网搜索暂时不可用，请稍后重试", 502);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new CommerceDomainError("search_response_too_large", "联网搜索响应过大", 502);
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) {
      throw new CommerceDomainError("search_response_too_large", "联网搜索响应过大", 502);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new CommerceDomainError("search_invalid_response", "联网搜索返回了无效响应", 502);
    }
    return parseResults(payload, limit);
  }
}

function parseResults(payload: unknown, limit: number): HostedSearchResult[] {
  const rows = payload && typeof payload === "object"
    && Array.isArray((payload as { results?: unknown }).results)
    ? (payload as { results: unknown[] }).results
    : [];
  const seen = new Set<string>();
  const results: HostedSearchResult[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    if (typeof item.title !== "string" || typeof item.url !== "string") continue;
    let url: URL;
    try { url = new URL(item.url); } catch { continue; }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || seen.has(url.href)) continue;
    seen.add(url.href);
    const content = typeof item.content === "string" ? item.content.trim().slice(0, 2_000) : "";
    const engine = typeof item.engine === "string" ? item.engine.trim().slice(0, 80) : "";
    results.push({
      title: item.title.trim().slice(0, 300) || url.hostname,
      url: url.href,
      content,
      ...(engine ? { engine } : {}),
    });
    if (results.length >= limit) break;
  }
  if (results.length === 0) {
    throw new CommerceDomainError("search_no_results", "没有找到可用的联网搜索结果", 404);
  }
  return results;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CommerceDomainError("invalid_request", "请求体必须是 JSON 对象", 400);
  }
  return value as Record<string, unknown>;
}

function requireQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 500) {
    throw new CommerceDomainError("invalid_request", "搜索关键词不能为空且不能超过 500 个字符", 400);
  }
  return value.trim();
}

function requireLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new CommerceDomainError("invalid_request", "maxResults 必须是 1 到 10 之间的整数", 400);
  }
  return value;
}
