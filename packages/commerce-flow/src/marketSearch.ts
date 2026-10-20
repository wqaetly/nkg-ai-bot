import { defineNode } from "@ai-native-flow/node-sdk";
import { z } from "zod";
import { checkSearchResponse } from "./searchFailure.js";
import { isAffiliateProductMatch } from "./commerce.js";
import type {
  BlueprintSlotV4,
  ComputerBlueprintV4,
  ComputerPartTypeV4,
} from "./computerAdvisorV4.js";

export const PUBLIC_MARKET_SEARCH_NODE_TYPE = "public_market_search";

export const PUBLIC_MARKET_SEARCH_ENV_KEYS = {
  enabled: "PUBLIC_MARKET_SEARCH_ENABLED",
  mode: "PUBLIC_MARKET_SEARCH_MODE",
  baseUrl: "PUBLIC_MARKET_SEARCH_BASE_URL",
  apiKey: "PUBLIC_MARKET_SEARCH_API_KEY",
  sessionToken: "PUBLIC_MARKET_SEARCH_SESSION_TOKEN",
} as const;

export interface PublicMarketPriceSample {
  price: number;
  title: string;
  url: string;
  capturedAt: string;
}

export interface PublicMarketPriceEvidence {
  slotId: string;
  partType: ComputerPartTypeV4;
  model: string;
  query: string;
  minPrice: number;
  medianPrice: number;
  maxPrice: number;
  samples: PublicMarketPriceSample[];
  confidence: "single_source" | "multi_source";
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

const configSchema = z.object({
  maxSlots: z.number().int().min(1).max(16).default(12),
  maxResultsPerSlot: z.number().int().min(1).max(10).default(6),
  concurrency: z.number().int().min(1).max(4).default(4),
}).passthrough();

export function createPublicMarketSearchNode(fetchImpl: typeof globalThis.fetch) {
  return defineNode({
    type: PUBLIC_MARKET_SEARCH_NODE_TYPE,
    typeVersion: "1.0.0",
    title: "公开市场价格发现",
    description: "按技术蓝图的具体型号查询公开网页，只输出可回溯来源中的人民币价格区间。",
    capabilities: {
      supportsCancel: true,
      requiredPermissions: ["network.http", "secret.read"],
    },
    config: configSchema,
    ports: [
      { id: "in", direction: "input", kind: "control", label: "搜索" },
      { id: "blueprint", direction: "input", kind: "data", label: "技术蓝图" },
      { id: "out", direction: "output", kind: "control", label: "完成" },
      { id: "evidence", direction: "output", kind: "data", label: "公开市场价格证据", schema: { type: "array" } },
      { id: "errors", direction: "output", kind: "data", label: "部分失败", schema: { type: "array" } },
      { id: "summary", direction: "output", kind: "data", label: "Summary" },
    ],
    validateInput: false,
    async run({ input, config, ctx }) {
      const blueprint = readBlueprint(input.blueprint);
      const slots = blueprint.slots.filter((slot) => slot.required)
        .slice(0, Math.max(1, Math.min(16, Number(config.maxSlots ?? 12))));
      const enabled = ctx.variables.getBoolean(PUBLIC_MARKET_SEARCH_ENV_KEYS.enabled) === true;
      const evidence: PublicMarketPriceEvidence[] = [];
      const errors: string[] = [];
      if (enabled && slots.length > 0) {
        const runtime = readSearchRuntime(ctx.variables);
        await mapWithConcurrency(
          slots,
          Math.max(1, Math.min(4, Number(config.concurrency ?? 4))),
          async (slot) => {
            const query = `${slot.primaryModel} ${marketplaceCategoryTerm(slot.partType)} 价格`;
            try {
              const results = await searchPublicMarket(
                runtime,
                query,
                Math.max(1, Math.min(10, Number(config.maxResultsPerSlot ?? 6))),
                fetchImpl,
                ctx.signal,
              );
              const aggregated = aggregateMarketEvidence(slot, query, results);
              if (aggregated) evidence.push(aggregated);
              else errors.push(`${slot.primaryModel}：公开搜索结果没有可验证的同型号人民币报价`);
            } catch (cause) {
              errors.push(`${slot.primaryModel}：${safeMessage(cause)}`);
            }
          },
        );
      } else if (!enabled && slots.length > 0) {
        errors.push("公开市场价格搜索未启用");
      }
      const order = new Map(slots.map((slot, index) => [slot.slotId, index]));
      evidence.sort((left, right) => (order.get(left.slotId) ?? 999) - (order.get(right.slotId) ?? 999));
      return {
        kind: "success" as const,
        outputs: {
          out: null,
          evidence,
          errors,
          summary: {
            enabled,
            searched: slots.length,
            priced: evidence.length,
            failed: errors.length,
          },
        },
      };
    },
  });
}

type VariableReader = {
  getString(name: string): string | undefined;
};

export function readSearchRuntime(variables: VariableReader): {
  mode: "searxng" | "nkg-session";
  baseUrl: string;
  authorization: string;
} {
  const mode = variables.getString(PUBLIC_MARKET_SEARCH_ENV_KEYS.mode) === "nkg-session"
    ? "nkg-session"
    : "searxng";
  const baseUrl = requireHttpUrl(variables.getString(PUBLIC_MARKET_SEARCH_ENV_KEYS.baseUrl));
  const authorization = mode === "nkg-session"
    ? variables.getString(PUBLIC_MARKET_SEARCH_ENV_KEYS.sessionToken) ?? ""
    : variables.getString(PUBLIC_MARKET_SEARCH_ENV_KEYS.apiKey) ?? "";
  if (mode === "nkg-session" && !authorization) throw new Error("NKG 搜索会话不可用");
  return { mode, baseUrl, authorization };
}

export async function searchPublicMarket(
  runtime: ReturnType<typeof readSearchRuntime>,
  query: string,
  maxResults: number,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const endpoint = new URL(runtime.baseUrl);
  let response: Response;
  if (runtime.mode === "nkg-session") {
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/api/app/v1/search`;
    endpoint.search = "";
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.authorization}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, maxResults }),
      signal,
    });
  } else {
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/search`;
    endpoint.search = "";
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        ...(runtime.authorization ? { "X-API-Key": runtime.authorization } : {}),
        Accept: "application/json",
      },
      signal,
    });
  }
  if (!response.ok) throw new Error(`公开市场搜索失败：HTTP ${response.status}`);
  const payload = await response.json() as unknown;
  checkSearchResponse(payload);
  return parseSearchResults(payload, maxResults);
}

function parseSearchResults(payload: unknown, limit: number): SearchResult[] {
  const record = asRecord(payload);
  const rows = Array.isArray(record?.results) ? record.results : [];
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const item = asRecord(row);
    const title = readText(item?.title, 500);
    const content = readText(item?.content, 3_000);
    const url = safeHttpUrl(readText(item?.url, 2_000));
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, content, url });
    if (results.length >= limit) break;
  }
  return results;
}

function aggregateMarketEvidence(
  slot: BlueprintSlotV4,
  query: string,
  results: SearchResult[],
): PublicMarketPriceEvidence | undefined {
  const capturedAt = new Date().toISOString();
  const samples: PublicMarketPriceSample[] = [];
  for (const result of results) {
    const searchable = `${result.title} ${result.content}`;
    if (!isAffiliateProductMatch(searchable, {
      keyword: slot.primaryModel,
      partType: slot.partType,
      stage: "exact_model",
      modelAnchors: modelIdentityAnchors(slot.primaryModel),
      requiredSpecs: slot.requiredSpecs,
    })) continue;
    const prices = extractCnyPrices(searchable)
      .filter((price) => plausibleMarketPrice(slot.partType, price));
    if (prices.length === 0) continue;
    samples.push({
      price: Math.min(...prices),
      title: result.title,
      url: result.url,
      capturedAt,
    });
  }
  const uniqueSamples = [...new Map(samples.map((sample) => [sample.url, sample])).values()]
    .sort((left, right) => left.price - right.price)
    .slice(0, 5);
  if (uniqueSamples.length === 0) return undefined;
  const prices = uniqueSamples.map((sample) => sample.price);
  return {
    slotId: slot.slotId,
    partType: slot.partType,
    model: slot.primaryModel,
    query,
    minPrice: prices[0]!,
    medianPrice: prices[Math.floor(prices.length / 2)]!,
    maxPrice: prices.at(-1)!,
    samples: uniqueSamples,
    confidence: uniqueSamples.length >= 2 ? "multi_source" : "single_source",
  };
}

function extractCnyPrices(value: string): number[] {
  const normalized = value.normalize("NFKC").replace(/,/g, "");
  const patterns = [
    /[¥￥]\s*(\d{2,6}(?:\.\d{1,2})?)/g,
    /(?:到手价|现价|售价|价格|报价|促销价)\s*[:：]?\s*(\d{2,6}(?:\.\d{1,2})?)\s*元?/g,
    /(\d{2,6}(?:\.\d{1,2})?)\s*元(?:起|到手|包邮|[，。；\s]|$)/g,
  ];
  const prices = patterns.flatMap((pattern) => [...normalized.matchAll(pattern)]
    .map((match) => Number(match[1]))
    .filter((price) => Number.isFinite(price)));
  return [...new Set(prices)].sort((left, right) => left - right);
}

const PRICE_BOUNDS: Record<ComputerPartTypeV4, [number, number]> = {
  cpu: [180, 30_000], cooler: [25, 8_000], motherboard: [180, 30_000], memory: [60, 20_000],
  gpu: [350, 100_000], storage: [60, 50_000], psu: [90, 10_000], case: [45, 20_000],
  monitor: [180, 100_000], keyboard: [20, 20_000], mouse: [15, 20_000], system: [600, 200_000],
};

function plausibleMarketPrice(partType: ComputerPartTypeV4, price: number): boolean {
  const [min, max] = PRICE_BOUNDS[partType];
  return price >= min && price <= max;
}

function modelIdentityAnchors(model: string): string[] {
  const stop = new Set(["amd", "intel", "nvidia", "geforce", "radeon", "core", "ryzen", "ddr4", "ddr5"]);
  const tokens = model.normalize("NFKC").toLocaleLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
  const anchors = tokens.filter((token) => /\d/.test(token) && token.length >= 3 && !stop.has(token));
  return [...new Set(anchors)].slice(0, 5);
}

function marketplaceCategoryTerm(partType: ComputerPartTypeV4): string {
  const terms: Record<ComputerPartTypeV4, string> = {
    cpu: "处理器", cooler: "CPU散热器", motherboard: "主板", memory: "内存条",
    gpu: "显卡", storage: "固态硬盘", psu: "电脑电源", case: "电脑机箱",
    monitor: "显示器", keyboard: "键盘", mouse: "鼠标", system: "整机",
  };
  return terms[partType];
}

function readBlueprint(value: unknown): ComputerBlueprintV4 {
  const record = asRecord(value);
  const slots = Array.isArray(record?.slots) ? record.slots.flatMap((item): BlueprintSlotV4[] => {
    const slot = asRecord(item);
    const partType = readPartType(slot?.partType);
    const slotId = readText(slot?.slotId, 200);
    const primaryModel = readText(slot?.primaryModel, 500);
    if (!partType || !slotId || !primaryModel) return [];
    return [{
      slotId,
      partType,
      required: slot?.required !== false,
      primaryModel,
      alternatives: [],
      requiredSpecs: asRecord(slot?.requiredSpecs) ?? {},
      reason: "",
      utilityWeight: 1,
      performanceTier: "balanced",
    }];
  }) : [];
  return {
    schemaVersion: "computer.blueprint.v4",
    route: "diy_full",
    slots,
    assumptions: [],
    notes: [],
  };
}

function readPartType(value: unknown): ComputerPartTypeV4 | undefined {
  const parts: ComputerPartTypeV4[] = [
    "cpu", "cooler", "motherboard", "memory", "gpu", "storage", "psu", "case",
    "monitor", "keyboard", "mouse", "system",
  ];
  return typeof value === "string" ? parts.find((part) => part === value) : undefined;
}

function requireHttpUrl(value: string | undefined): string {
  const url = safeHttpUrl(value ?? "");
  if (!url) throw new Error("公开市场搜索地址无效");
  return url;
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeMessage(value: unknown): string {
  return value instanceof Error ? value.message.slice(0, 300) : String(value).slice(0, 300);
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const value = values[cursor++];
      if (value !== undefined) await task(value);
    }
  }));
}
