import type { NodeEvent } from "@nkg-ai-bot/runtime-router";
import { chatMessageSummary } from "./chatContent";
import {
  COMPUTER_PRODUCT_PLANNER_FLOW_ID,
  COMPUTER_PRODUCT_PLANNER_FLOW_VERSION,
} from "./builtinFlows";
import type { AffiliateProduct, AffiliateProductQuery } from "./commerce";
import type { LocalMessage } from "./storage/repositories";

export interface CommercePlanningRuntime {
  stream(
    flowId: string,
    input: unknown,
    options?: { flowVersion?: string; signal?: AbortSignal },
  ): AsyncIterable<NodeEvent>;
}

export interface AffiliateCommerceClient {
  isAffiliateCommerceEnabled(): boolean;
  searchAffiliateProducts(
    query: AffiliateProductQuery,
    options?: { signal?: AbortSignal },
  ): Promise<AffiliateProduct[]>;
}

export interface AffiliateRecommendationContext {
  queries: AffiliateProductQuery[];
  products: AffiliateProduct[];
  errors: string[];
}

export async function collectAffiliateRecommendations(
  runtime: CommercePlanningRuntime,
  commerce: AffiliateCommerceClient,
  messages: LocalMessage[],
  signal?: AbortSignal,
): Promise<AffiliateRecommendationContext> {
  const prompt = buildProductQueryPlannerPrompt(messages);
  let streamed = "";
  let finalOutput = "";
  for await (const event of runtime.stream(COMPUTER_PRODUCT_PLANNER_FLOW_ID, prompt, {
    flowVersion: COMPUTER_PRODUCT_PLANNER_FLOW_VERSION,
    ...(signal ? { signal } : {}),
  })) {
    if (event.kind === "stream_delta" && event.nodeId === "product_query_planner") {
      streamed += readText(event.payload);
    }
    if (event.kind === "run_finished") finalOutput = readOutput(event.payload) || finalOutput;
    if (event.kind === "node_error" || event.kind === "run_failed") {
      throw new Error(readRuntimeError(event.payload));
    }
    if (event.kind === "run_cancelled") throw new DOMException("商品查询规划已取消", "AbortError");
  }
  const queries = parseProductQueryPlan(finalOutput || streamed);
  if (queries.length === 0) return { queries: [], products: [], errors: [] };

  const products: AffiliateProduct[] = [];
  const errors: string[] = [];
  await mapWithConcurrency(queries, 3, async (query) => {
    try {
      products.push(...await commerce.searchAffiliateProducts(query, { ...(signal ? { signal } : {}) }));
    } catch (cause) {
      errors.push(`${query.keyword}：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  });
  return { queries, products, errors };
}

export function buildProductQueryPlannerPrompt(messages: LocalMessage[]): string {
  const transcript = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-8)
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${chatMessageSummary(message.content).slice(0, 1200)}`)
    .join("\n\n")
    .slice(-7000);
  return `你是电脑配置商品查询规划器。根据对话判断本轮是否需要在联盟电商平台查询真实商品。

只输出一个 JSON 对象，不要输出 Markdown：
{"queries":[{"keyword":"具体型号与品类","minPrice":1000,"maxPrice":2000,"count":2}]}

规则：
- 若用户仍缺少关键预算/用途、只问知识问题、或本轮不需要购买建议，返回 {"queries":[]}。
- 若用户要求装机、升级、购买或核价，先在内部拟定平衡方案，再为需要购买的核心部件生成查询。
- keyword 必须包含明确型号和品类，例如“AMD Ryzen 7 9700X 处理器”，不能只写“CPU”或“显卡”。
- 最多 8 条查询，每条 count 只能为 1 或 2；价格单位人民币，可省略 minPrice/maxPrice。
- 不要生成外设以外的无关商品，不要输出链接、解释或任何凭据。

对话：
${transcript}`;
}

export function parseProductQueryPlan(value: string): AffiliateProductQuery[] {
  const json = extractJsonObject(value);
  const parsed = JSON.parse(json) as { queries?: unknown };
  if (!Array.isArray(parsed.queries)) throw new Error("商品查询规划缺少 queries 数组");
  const queries: AffiliateProductQuery[] = [];
  for (const raw of parsed.queries.slice(0, 8)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.keyword !== "string" || !item.keyword.trim()) continue;
    const minPrice = optionalPrice(item.minPrice);
    const maxPrice = optionalPrice(item.maxPrice);
    if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) continue;
    queries.push({
      keyword: item.keyword.trim().replace(/\s+/g, " ").slice(0, 120),
      count: item.count === 1 ? 1 : 2,
      ...(minPrice !== undefined ? { minPrice } : {}),
      ...(maxPrice !== undefined ? { maxPrice } : {}),
    });
  }
  return dedupeQueries(queries);
}

function dedupeQueries(queries: AffiliateProductQuery[]): AffiliateProductQuery[] {
  const seen = new Set<string>();
  return queries.filter((query) => {
    const key = query.keyword.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function optionalPrice(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10_000_000
    ? Math.round(parsed * 100) / 100
    : undefined;
}

function extractJsonObject(value: string): string {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("商品查询规划不是有效 JSON");
  return trimmed.slice(start, end + 1);
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      await task(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
}

function readText(payload: unknown): string {
  return payload && typeof payload === "object" && typeof (payload as { text?: unknown }).text === "string"
    ? (payload as { text: string }).text
    : "";
}

function readOutput(payload: unknown): string {
  return payload && typeof payload === "object" && typeof (payload as { output?: unknown }).output === "string"
    ? (payload as { output: string }).output
    : "";
}

function readRuntimeError(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "商品查询规划失败";
  const error = (payload as { error?: unknown }).error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return "商品查询规划失败";
}
