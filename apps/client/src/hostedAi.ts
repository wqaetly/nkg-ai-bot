import type { FlowInvokeOptions } from "@nkg-ai-bot/runtime-router";

export const DEFAULT_HOSTED_AI_SERVICE_URL = "https://api.lfzxb.top";
export const HOSTED_AI_PROVIDER_ID = "nkg-hosted";
export const HOSTED_AI_SESSION_TOKEN_REF = "hosted-ai:nkg:session-token";
export const HOSTED_AI_RECOVERY_TOKEN_REF = "hosted-ai:nkg:recovery-token";

export type HostedAiPlatform = "windows" | "macos" | "linux" | "android" | "ios";

export interface HostedAiBalance {
  availablePoints: number;
  purchasedPoints: number;
  grantedPoints: number;
  updatedAt: string;
}

export interface HostedAiModel {
  id: string;
  name: string;
  contextWindow: number;
  inputPointsPerMillionTokens: number;
  outputPointsPerMillionTokens: number;
  capabilities: Array<"text" | "vision" | "reasoning" | "tools" | "image-generation">;
}

export interface HostedAiPointPack {
  id: string;
  points: number;
  appleProductId: string;
  featured: boolean;
}

export interface HostedAiAccount {
  accountId: string;
  appAccountToken: string;
  balance: HostedAiBalance;
  models: HostedAiModel[];
  pointPacks: HostedAiPointPack[];
}

export interface HostedAiSessionGrant extends HostedAiAccount {
  sessionToken: string;
  sessionExpiresAt: string;
  recoveryToken?: string;
}

export interface HostedAiRunAuthorization {
  authorizationId: string;
  apiBaseUrl: string;
  apiKey: string;
  expiresAt: string;
  balance: HostedAiBalance;
}

export interface HostedAiPurchaseResult {
  transactionId: string;
  creditedPoints: number;
  balance: HostedAiBalance;
}

export interface HostedAiSearchResult {
  title: string;
  url: string;
  content: string;
  engine?: string;
}

export interface StartHostedAiSessionInput {
  installationId: string;
  platform: HostedAiPlatform;
  appVersion: string;
}

export interface RecoverHostedAiSessionInput extends StartHostedAiSessionInput {
  recoveryToken: string;
}

export interface AuthorizeHostedAiRunInput {
  requestId: string;
  flowId: string;
  modelId: string;
}

export interface RedeemApplePurchaseInput {
  appAccountToken: string;
  signedTransactionInfo: string;
}

export class HostedAiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HostedAiApiError";
  }
}

/**
 * Client for the app-facing commerce boundary in front of New API.
 *
 * The app never receives an administrator credential or a permanent New API
 * token. The commerce service returns a short-lived, run-scoped gateway key
 * only after it has checked the account balance and selected model.
 */
export class HostedAiClient {
  private readonly serviceUrl: URL;

  constructor(
    serviceUrl = DEFAULT_HOSTED_AI_SERVICE_URL,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.serviceUrl = normalizeServiceUrl(serviceUrl);
  }

  async startAnonymousSession(
    input: StartHostedAiSessionInput,
    signal?: AbortSignal,
  ): Promise<HostedAiSessionGrant> {
    const payload = await this.request("/api/app/v1/sessions/anonymous", {
      method: "POST",
      body: input,
      signal,
    });
    return parseSessionGrant(payload);
  }

  async getAccount(sessionToken: string, signal?: AbortSignal): Promise<HostedAiAccount> {
    const payload = await this.request("/api/app/v1/account", {
      method: "GET",
      sessionToken,
      signal,
    });
    return parseAccount(payload);
  }

  async recoverAnonymousSession(
    input: RecoverHostedAiSessionInput,
    signal?: AbortSignal,
  ): Promise<HostedAiSessionGrant> {
    const payload = await this.request("/api/app/v1/sessions/recover", {
      method: "POST",
      body: input,
      signal,
    });
    return parseSessionGrant(payload);
  }

  async rotateRecoveryToken(sessionToken: string, signal?: AbortSignal): Promise<string> {
    const payload = await this.request("/api/app/v1/account/recovery/rotate", {
      method: "POST",
      sessionToken,
      signal,
    });
    const object = requireObject(payload, "账户恢复响应");
    return requireRecoveryToken(object.recoveryToken);
  }

  async authorizeRun(
    sessionToken: string,
    input: AuthorizeHostedAiRunInput,
    signal?: AbortSignal,
  ): Promise<HostedAiRunAuthorization> {
    const payload = await this.request("/api/app/v1/runs/authorize", {
      method: "POST",
      sessionToken,
      idempotencyKey: input.requestId,
      body: input,
      signal,
    });
    return parseRunAuthorization(payload);
  }

  async completeRun(
    sessionToken: string,
    authorizationId: string,
    signal?: AbortSignal,
  ): Promise<HostedAiBalance> {
    const payload = await this.request("/api/app/v1/runs/complete", {
      method: "POST",
      sessionToken,
      body: { authorizationId },
      signal,
    });
    return parseBalance(requireObject(payload, "运行完成响应").balance);
  }

  async redeemApplePurchase(
    sessionToken: string,
    input: RedeemApplePurchaseInput,
    signal?: AbortSignal,
  ): Promise<HostedAiPurchaseResult> {
    const payload = await this.request("/api/app/v1/purchases/apple", {
      method: "POST",
      sessionToken,
      idempotencyKey: purchaseIdempotencyKey(input.signedTransactionInfo),
      body: input,
      signal,
    });
    return parsePurchaseResult(payload);
  }

  async searchWeb(
    sessionToken: string,
    query: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<HostedAiSearchResult[]> {
    const payload = await this.request("/api/app/v1/search", {
      method: "POST",
      sessionToken,
      body: { query: query.trim().slice(0, 500), maxResults },
      signal,
    });
    return parseSearchResults(payload, maxResults);
  }

  async createRunOptions(
    sessionToken: string,
    input: AuthorizeHostedAiRunInput,
    options: FlowInvokeOptions = {},
    signal?: AbortSignal,
  ): Promise<{ options: FlowInvokeOptions; authorization: HostedAiRunAuthorization }> {
    const authorization = await this.authorizeRun(sessionToken, input, signal);
    return {
      authorization,
      options: {
        ...options,
        envOverrides: {
          variables: {
            ...options.envOverrides?.variables,
            LLM_BASE_URL: authorization.apiBaseUrl,
            LLM_DEFAULT_MODEL: input.modelId,
          },
          secrets: {
            ...options.envOverrides?.secrets,
            LLM_API_KEY: authorization.apiKey,
          },
        },
      },
    };
  }

  private async request(
    path: string,
    input: {
      method: "GET" | "POST";
      sessionToken?: string;
      idempotencyKey?: string;
      body?: unknown;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const endpoint = new URL(path, this.serviceUrl);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (input.body !== undefined) headers["Content-Type"] = "application/json";
    if (input.sessionToken) headers.Authorization = `Bearer ${requireSecret(input.sessionToken)}`;
    if (input.idempotencyKey) headers["Idempotency-Key"] = requireText(input.idempotencyKey, "幂等键");

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: input.method,
        headers,
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        signal: input.signal,
      });
    } catch (cause) {
      if (input.signal?.aborted) throw cause;
      throw new HostedAiApiError("无法连接 NKG AI 服务，请稍后重试", 0, "network_error", true);
    }

    const payload = await readJson(response);
    if (!response.ok) throw parseApiError(payload, response.status);
    return unwrapData(payload);
  }
}

function parseSessionGrant(payload: unknown): HostedAiSessionGrant {
  const object = requireObject(payload, "会话响应");
  return {
    ...parseAccount(object),
    sessionToken: requireSecret(object.sessionToken),
    sessionExpiresAt: requireIsoDate(object.sessionExpiresAt, "会话过期时间"),
    ...(object.recoveryToken === undefined
      ? {}
      : { recoveryToken: requireRecoveryToken(object.recoveryToken) }),
  };
}

function parseAccount(payload: unknown): HostedAiAccount {
  const object = requireObject(payload, "账户响应");
  const models = requireArray(object.models, "模型列表").map(parseModel);
  const pointPacks = object.pointPacks === undefined
    ? []
    : requireArray(object.pointPacks, "点数商品列表").map(parsePointPack);
  if (!models.length) throw invalidResponse("NKG AI 暂时没有可用模型");
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) throw invalidResponse(`模型列表包含重复标识：${model.id}`);
    ids.add(model.id);
  }
  const packIds = new Set<string>();
  const appleProductIds = new Set<string>();
  for (const pointPack of pointPacks) {
    if (packIds.has(pointPack.id) || appleProductIds.has(pointPack.appleProductId)) {
      throw invalidResponse("点数商品列表包含重复标识");
    }
    packIds.add(pointPack.id);
    appleProductIds.add(pointPack.appleProductId);
  }
  return {
    accountId: requireText(object.accountId, "账户标识"),
    appAccountToken: requireUuid(object.appAccountToken, "App Store 账户标识"),
    balance: parseBalance(object.balance),
    models,
    pointPacks,
  };
}

function parseBalance(payload: unknown): HostedAiBalance {
  const object = requireObject(payload, "点数余额");
  return {
    availablePoints: requireNonNegativeInteger(object.availablePoints, "可用点数"),
    purchasedPoints: requireNonNegativeInteger(object.purchasedPoints, "已购点数"),
    grantedPoints: requireNonNegativeInteger(object.grantedPoints, "赠送点数"),
    updatedAt: requireIsoDate(object.updatedAt, "余额更新时间"),
  };
}

function parseModel(payload: unknown): HostedAiModel {
  const object = requireObject(payload, "模型");
  const capabilities = requireArray(object.capabilities, "模型能力").map((value) => {
    if (!isHostedCapability(value)) throw invalidResponse("模型包含未知能力");
    return value;
  });
  return {
    id: requireText(object.id, "模型标识"),
    name: requireText(object.name, "模型名称"),
    contextWindow: requirePositiveInteger(object.contextWindow, "上下文窗口"),
    inputPointsPerMillionTokens: requireNonNegativeInteger(
      object.inputPointsPerMillionTokens,
      "输入点数倍率",
    ),
    outputPointsPerMillionTokens: requireNonNegativeInteger(
      object.outputPointsPerMillionTokens,
      "输出点数倍率",
    ),
    capabilities: [...new Set(capabilities)],
  };
}

function parsePointPack(payload: unknown): HostedAiPointPack {
  const object = requireObject(payload, "点数商品");
  return {
    id: requireText(object.id, "点数商品标识"),
    points: requirePositiveInteger(object.points, "商品点数"),
    appleProductId: requireText(object.appleProductId, "App Store 商品标识"),
    featured: object.featured === true,
  };
}

function parseRunAuthorization(payload: unknown): HostedAiRunAuthorization {
  const object = requireObject(payload, "运行授权");
  const apiBaseUrl = new URL(requireText(object.apiBaseUrl, "模型服务地址"));
  if (apiBaseUrl.protocol !== "https:") throw invalidResponse("模型服务地址必须使用 HTTPS");
  return {
    authorizationId: requireText(object.authorizationId, "运行授权标识"),
    apiBaseUrl: apiBaseUrl.href.replace(/\/$/, ""),
    apiKey: requireSecret(object.apiKey),
    expiresAt: requireIsoDate(object.expiresAt, "运行授权过期时间"),
    balance: parseBalance(object.balance),
  };
}

function parsePurchaseResult(payload: unknown): HostedAiPurchaseResult {
  const object = requireObject(payload, "交易入账响应");
  return {
    transactionId: requireText(object.transactionId, "Apple 交易标识"),
    creditedPoints: requirePositiveInteger(object.creditedPoints, "入账点数"),
    balance: parseBalance(object.balance),
  };
}

function parseSearchResults(payload: unknown, maximum: number): HostedAiSearchResult[] {
  const rows = requireArray(payload, "联网搜索结果");
  const results: HostedAiSearchResult[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const object = requireObject(row, "联网搜索结果");
    let url: URL;
    try {
      url = new URL(requireText(object.url, "搜索结果 URL"));
    } catch {
      throw invalidResponse("搜索结果 URL 格式无效");
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || seen.has(url.href)) continue;
    seen.add(url.href);
    const engine = typeof object.engine === "string" ? object.engine.trim().slice(0, 80) : "";
    results.push({
      title: requireText(object.title, "搜索结果标题").slice(0, 300),
      url: url.href,
      content: typeof object.content === "string" ? object.content.trim().slice(0, 2_000) : "",
      ...(engine ? { engine } : {}),
    });
    if (results.length >= Math.min(Math.max(maximum, 1), 10)) break;
  }
  if (!results.length) throw invalidResponse("NKG AI 搜索没有返回可用结果");
  return results;
}

function parseApiError(payload: unknown, status: number): HostedAiApiError {
  const object = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const error = object.error && typeof object.error === "object"
    ? object.error as Record<string, unknown>
    : object;
  const code = typeof error.code === "string" && error.code.trim()
    ? error.code.trim().slice(0, 80)
    : `http_${status}`;
  const publicMessage = typeof error.message === "string" && error.message.trim()
    ? error.message.trim().slice(0, 300)
    : defaultErrorMessage(status);
  return new HostedAiApiError(publicMessage, status, code, status === 429 || status >= 500);
}

function unwrapData(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || !("data" in payload)) return payload;
  return (payload as { data: unknown }).data;
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    if (response.ok) throw invalidResponse("NKG AI 服务返回了无法识别的响应");
    return {};
  }
  try {
    return await response.json() as unknown;
  } catch {
    throw invalidResponse("NKG AI 服务返回了损坏的响应");
  }
}

function normalizeServiceUrl(value: string): URL {
  const url = new URL(value.trim());
  if (url.username || url.password) throw new Error("NKG AI 服务地址不能包含凭据");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("NKG AI 服务地址必须使用 HTTPS");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
  url.search = "";
  url.hash = "";
  return url;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function purchaseIdempotencyKey(signedTransactionInfo: string): string {
  const value = requireSecret(signedTransactionInfo);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `apple-${(hash >>> 0).toString(16).padStart(8, "0")}-${value.length}`;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(`${label}格式无效`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw invalidResponse(`${label}格式无效`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalidResponse(`${label}不能为空`);
  return value.trim();
}

function requireSecret(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 8) {
    throw invalidResponse("服务凭据无效");
  }
  return value.trim();
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidResponse(`${label}必须是非负整数`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const number = requireNonNegativeInteger(value, label);
  if (number === 0) throw invalidResponse(`${label}必须大于零`);
  return number;
}

function requireIsoDate(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!Number.isFinite(Date.parse(text))) throw invalidResponse(`${label}格式无效`);
  return text;
}

function requireUuid(value: unknown, label: string): string {
  const text = requireText(value, label).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) {
    throw invalidResponse(`${label}格式无效`);
  }
  return text;
}

function requireRecoveryToken(value: unknown): string {
  const text = requireText(value, "账户恢复码");
  if (!/^nkg_recover_[A-Za-z0-9_-]{43}$/.test(text)) {
    throw invalidResponse("账户恢复码格式无效");
  }
  return text;
}

function isHostedCapability(value: unknown): value is HostedAiModel["capabilities"][number] {
  return value === "text" || value === "vision" || value === "reasoning"
    || value === "tools" || value === "image-generation";
}

function invalidResponse(message: string): HostedAiApiError {
  return new HostedAiApiError(message, 502, "invalid_response", false);
}

function defaultErrorMessage(status: number): string {
  if (status === 401) return "NKG AI 登录状态已失效，请重新连接";
  if (status === 402) return "AI 点数不足，请充值后重试";
  if (status === 403) return "当前账户无权使用这个模型";
  if (status === 429) return "NKG AI 请求过于频繁，请稍后重试";
  return status >= 500 ? "NKG AI 服务暂时不可用，请稍后重试" : `NKG AI 请求失败：HTTP ${status}`;
}
