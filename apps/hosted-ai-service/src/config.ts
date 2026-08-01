import { readFile } from "node:fs/promises";
import type { ModelRate, PointPack } from "./domain.js";

export interface ServiceConfig {
  port: number;
  databaseUrl: string;
  publicBaseUrl: string;
  sessionDays: number;
  runTtlSeconds: number;
  welcomeGrantPoints: number;
  runTokenSecret: string;
  newApiBaseUrl: string;
  newApiKey: string;
  appleBundleId: string;
  appleAppId: number;
  appleRootCertificates: Buffer[];
  models: ModelRate[];
  pointPacks: PointPack[];
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ServiceConfig> {
  const publicBaseUrl = httpsUrl(required(env, "NKG_PUBLIC_BASE_URL"), "NKG_PUBLIC_BASE_URL");
  const newApiBaseUrl = normalizeNewApiBaseUrl(serviceUrl(
    required(env, "NEW_API_BASE_URL"),
    "NEW_API_BASE_URL",
    env.NEW_API_ALLOW_INSECURE_HTTP === "true",
  ));
  const rootPaths = required(env, "APPLE_ROOT_CA_PATHS").split(",").map((value) => value.trim()).filter(Boolean);
  if (!rootPaths.length) throw new Error("APPLE_ROOT_CA_PATHS 至少需要一个 Apple 根证书");
  const appleRootCertificates = await Promise.all(rootPaths.map((path) => readFile(path)));
  const models = parseModels(required(env, "NKG_MODELS_JSON"));
  const pointPacks = parsePointPacks(required(env, "NKG_POINT_PACKS_JSON"));
  return {
    port: integer(env.PORT ?? "8787", "PORT", 1, 65_535),
    databaseUrl: required(env, "DATABASE_URL"),
    publicBaseUrl,
    sessionDays: integer(env.NKG_SESSION_DAYS ?? "30", "NKG_SESSION_DAYS", 1, 365),
    runTtlSeconds: integer(env.NKG_RUN_TTL_SECONDS ?? "300", "NKG_RUN_TTL_SECONDS", 30, 900),
    welcomeGrantPoints: integer(env.NKG_WELCOME_GRANT_POINTS ?? "0", "NKG_WELCOME_GRANT_POINTS", 0, 1_000_000),
    runTokenSecret: secret(env, "NKG_RUN_TOKEN_SECRET", 32),
    newApiBaseUrl,
    newApiKey: secret(env, "NEW_API_KEY", 8),
    appleBundleId: required(env, "APPLE_BUNDLE_ID"),
    appleAppId: integer(required(env, "APPLE_APP_ID"), "APPLE_APP_ID", 1, Number.MAX_SAFE_INTEGER),
    appleRootCertificates,
    models,
    pointPacks,
  };
}

export function normalizeNewApiBaseUrl(value: string): string {
  return value.replace(/\/v1$/, "");
}

export function parseModels(value: string): ModelRate[] {
  const raw = jsonArray(value, "NKG_MODELS_JSON");
  const models = raw.map((item, index) => {
    const object = record(item, `模型 ${index + 1}`);
    const capabilities = stringArray(object.capabilities, "capabilities");
    if (capabilities.some((capability) => !MODEL_CAPABILITIES.has(capability))) {
      throw new Error(`模型 ${index + 1} 包含未知 capability`);
    }
    return {
      id: text(object.id, "模型 id"),
      name: text(object.name, "模型 name"),
      contextWindow: positiveInteger(object.contextWindow, "contextWindow"),
      inputPointsPerMillionTokens: nonNegativeInteger(object.inputPointsPerMillionTokens, "inputPointsPerMillionTokens"),
      outputPointsPerMillionTokens: nonNegativeInteger(object.outputPointsPerMillionTokens, "outputPointsPerMillionTokens"),
      reservePoints: positiveInteger(object.reservePoints, "reservePoints"),
      capabilities,
    } satisfies ModelRate;
  });
  requireUnique(models.map((model) => model.id), "模型 id");
  if (!models.length) throw new Error("NKG_MODELS_JSON 不能为空");
  return models;
}

export function parsePointPacks(value: string): PointPack[] {
  const packs = jsonArray(value, "NKG_POINT_PACKS_JSON").map((item, index) => {
    const object = record(item, `点数商品 ${index + 1}`);
    return {
      id: text(object.id, "商品 id"),
      points: positiveInteger(object.points, "points"),
      appleProductId: text(object.appleProductId, "appleProductId"),
      featured: object.featured === true,
    } satisfies PointPack;
  });
  requireUnique(packs.map((pack) => pack.id), "商品 id");
  requireUnique(packs.map((pack) => pack.appleProductId), "Apple 商品 id");
  return packs;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${key}`);
  return value;
}

function secret(env: NodeJS.ProcessEnv, key: string, minimum: number): string {
  const value = required(env, key);
  if (value.length < minimum) throw new Error(`${key} 长度不能小于 ${minimum}`);
  return value;
}

function httpsUrl(value: string, label: string): string {
  return serviceUrl(value, label, false);
}

function serviceUrl(value: string, label: string, allowInsecureHttp: boolean): string {
  const url = new URL(value);
  if (url.username || url.password) throw new Error(`${label} 不能在 URL 中包含凭据`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (
    allowInsecureHttp || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  ))) {
    throw new Error(`${label} 必须使用 HTTPS`);
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href.replace(/\/$/, "");
}

function integer(value: string, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return parsed;
}

function jsonArray(value: string, label: string): unknown[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${label} 不是有效 JSON`); }
  if (!Array.isArray(parsed)) throw new Error(`${label} 必须是数组`);
  return parsed;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 不能为空`);
  return value.trim();
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (!parsed) throw new Error(`${label} 必须大于零`);
  return parsed;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label} 必须是字符串数组`);
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function requireUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} 不能重复`);
}

const MODEL_CAPABILITIES = new Set([
  "text",
  "vision",
  "reasoning",
  "tools",
  "image-generation",
]);
