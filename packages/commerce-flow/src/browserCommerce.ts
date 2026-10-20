import { defineNode } from "@ai-native-flow/node-sdk";
import { z } from "zod";
import type { AffiliateProduct, AffiliateSearchTelemetry, BrowserPageDiagnostic, ProductProvider } from "./commerce.js";
import { readQueries } from "./node.js";

export const BROWSER_COMMERCE_ENDPOINT = "https://commerce.nkg.local/collect";
export const SHOPPING_PLATFORM_VARIABLE = "COMPUTER_SHOPPING_PLATFORM";
export const SHOPPING_PLATFORMS = [
  { value: "pdd", label: "拼多多" },
  { value: "jd", label: "京东" },
  { value: "taobao", label: "淘宝" },
] as const;

export function isShoppingPlatform(value: unknown): value is ProductProvider {
  return SHOPPING_PLATFORMS.some((platform) => platform.value === value);
}

export function hasAmbiguousModelPrice(partType: string | undefined, title: string): boolean {
  if (partType === "memory") {
    const speeds = title.match(/(?<!\d)[4-9]\d{3}(?!\d)/g) ?? [];
    return new Set(speeds).size > 1 || /\d+\s*g(?:b)?\s*[/／]\s*\d+\s*g/i.test(title);
  }
  if (partType === "gpu") {
    const models = [...title.matchAll(/(?:rx|rtx|gtx)\s*\d{3,4}\s*(?:xt|ti|super|gre)?/gi)].map((m) => m[0].replace(/\s/g, "").toLowerCase());
    return new Set(models).size > 1 || /\d+\s*g(?:b)?\s*[/／]\s*\d+\s*g/i.test(title);
  }
  if (partType === "motherboard") return new Set((title.match(/[abhxz]\d{3}m?/gi) ?? []).map((m) => m.toLowerCase())).size > 1;
  if (partType !== "cpu") return false;
  const models = [...title.normalize("NFKC").matchAll(/\b[ri][3579][ -]*(\d{4,5}[a-z0-9]*)\b|\b(\d{4,5}(?:x3d|[fkx]{1,2}))\b/gi)]
    .map((match) => (match[1] ?? match[2])!.toLowerCase());
  return new Set(models).size > 1;
}

/** Query metadata is planned intent, never evidence of a listing's category or model. */
export function matchesCommerceIdentity(partType: string | undefined, titleValue: string, anchors: string[] = [], keyword = "", categoryEvidence = true): boolean {
  const title = titleValue.normalize("NFKC").toLowerCase();
  const compact = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s_-]/g, "");
  if (categoryEvidence && partType === "cpu" && /显卡|\b(?:rx|rtx|gtx)\s*\d|主板|散热器|整机|游戏主机/.test(title)) return false;
  if (categoryEvidence && partType === "gpu" && /主板|散热器|整机|游戏主机/.test(title)) return false;
  if (categoryEvidence && partType === "motherboard" && /显卡|散热器|整机/.test(title)) return false;
  if (!anchors.length) return true;
  if (partType === "cpu" || partType === "gpu") {
    if (partType === "cpu" && anchors.some((anchor) => /ultra/i.test(anchor))) {
      const models = [...title.matchAll(/(?:core\s*)?ultra\s*[3579]\s*\d{3}[a-z]*/gi)].map((match) => compact(match[0]).replace(/^core/, ""));
      return anchors.some((anchor) => models.includes(compact(anchor).replace(/^core/, "")));
    }
    const expectedFamily = partType === "gpu" ? keyword.match(/\b(rx|rtx|gtx|arc)\b/i)?.[1] : undefined;
    if (expectedFamily && !new RegExp(`${expectedFamily}\\s*(?:\\d|[ab]\\d)`, "i").test(title)) return false;
    const models = partType === "gpu"
      ? [...title.matchAll(/(?:rx|rtx|gtx)\s*(\d{3,4})\s*(xtx|xt|ti\s*super|ti|super|gre)?|arc\s*([ab]\d{3})/gi)].map((m) => compact(m[3] ?? `${m[1]}${m[2] ?? ""}`))
      : [...title.matchAll(/(?<![a-z0-9])(?:[ri][3579][ -]*)?(\d{4,5}(?:x3d|[fkxgs]{1,2})?)(?![a-z0-9])/gi)].map((m) => compact(m[1]!));
    return anchors.some((anchor) => models.includes(compact(anchor).replace(/^i[3579]/, "")));
  }
  const hits = anchors.filter((anchor) => compact(title).includes(compact(anchor)));
  if (partType === "motherboard") {
    const brands = [["微星", "msi"], ["华硕", "asus"], ["技嘉", "gigabyte"], ["华擎", "asrock"]];
    const brand = brands.find((aliases) => aliases.some((alias) => keyword.toLowerCase().includes(alias)));
    if (brand && !brand.some((alias) => title.includes(alias))) return false;
    // Preserve model suffixes (PRO ...-A vs ...-P), not just the chipset.
    const suffix = keyword.match(/\b([abhxz]\d{3}m?)[ -]+(a|p|k|e|plus)\b/i);
    if (suffix && !compact(title).includes(compact(`${suffix[1]}${suffix[2]}`))) return false;
  }
  return hits.length >= (partType === "memory" && anchors.length >= 2 ? 2 : 1);
}

/** Accept only direct product URLs on the selected marketplace. Never expose tracking redirects. */
export function directProductUrl(provider: ProductProvider, raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 2000) return undefined;
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return undefined;
    if (provider === "jd" && url.hostname === "item.jd.com" && /^\/\d+\.html$/.test(url.pathname)) {
      return `https://item.jd.com${url.pathname}`;
    }
    if (provider === "pdd" && ["mobile.yangkeduo.com", "mobile.pinduoduo.com"].includes(url.hostname)
      && url.pathname === "/goods.html" && /^\d+$/.test(url.searchParams.get("goods_id") ?? "")) {
      return `https://mobile.yangkeduo.com/goods.html?goods_id=${url.searchParams.get("goods_id")}`;
    }
    if (provider === "taobao" && ["item.taobao.com", "detail.tmall.com"].includes(url.hostname)
      && url.pathname === "/item.htm" && /^\d+$/.test(url.searchParams.get("id") ?? "")) {
      return `https://${url.hostname}/item.htm?id=${url.searchParams.get("id")}`;
    }
  } catch { /* Untrusted page data. */ }
  return undefined;
}

export function productPurchaseUrl(product: Pick<AffiliateProduct, "provider" | "sourceKind" | "sourceUrl" | "promotionUrl" | "detailVerified">): string | undefined {
  return product.sourceKind === "browser"
    ? product.detailVerified === true ? directProductUrl(product.provider, product.sourceUrl) : undefined
    : product.promotionUrl;
}

type PageResult = { status: string; products?: unknown[]; diagnostics?: Record<string, unknown> };
const STATUS_MESSAGES: Record<string, string> = {
  login_required: "需要登录，请在当前对话配置中打开商城登录窗口，完成登录后重试",
  verification_required: "平台要求验证，请在当前对话配置中打开商城窗口完成验证后重试",
  parser_unmatched: "页面已打开，但未识别到商品数据（可能是页面结构变化）",
  unavailable: "商品页面不可用或商品已下架",
  unsupported: "当前设备不支持商城浏览器采集，请使用桌面客户端",
  timeout: "页面加载超时",
  native_error: "本机商城窗口创建或调用失败",
};

function pageDiagnostic(result: PageResult, phase: "search" | "detail"): BrowserPageDiagnostic {
  const raw = result.diagnostics ?? {};
  const safeUrl = (value: unknown) => {
    if (typeof value !== "string") return undefined;
    try { const u = new URL(value); return u.protocol === "https:" ? `${u.origin}${u.pathname}`.slice(0, 240) : undefined; }
    catch { return undefined; }
  };
  const diagnostic: BrowserPageDiagnostic = { phase,
    status: ["ok", "empty", ...Object.keys(STATUS_MESSAGES)].includes(result.status) ? result.status : "invalid_response" };
  const url = safeUrl(raw.pageUrl);
  if (url) diagnostic.pageUrl = url;
  for (const key of ["elapsedMs", "responses", "jsonp", "parseErrors", "productLinks", "productCount", "missingTitle", "missingPrice", "rejectedIdentity"] as const) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key])) diagnostic[key] = Math.min(1_000_000, Math.max(0, Math.floor(raw[key])));
  }
  if (["loading", "interactive", "complete", "unknown"].includes(String(raw.readyState))) diagnostic.readyState = String(raw.readyState);
  if (Array.isArray(raw.sources)) diagnostic.sources = raw.sources.slice(0, 8).flatMap((s) => safeUrl(s) ?? []);
  if (Array.isArray(raw.shapes)) diagnostic.shapes = raw.shapes.filter((s): s is string => typeof s === "string"
    && ["itemsArray", "auctions", "resultList", "goods_list", "item", "skuCore", "apiStack", "goods", "price"].includes(s)).slice(0, 10);
  return diagnostic;
}

function browserCandidates(value: unknown, provider: ProductProvider) {
  if (!Array.isArray(value)) return [];
  const candidates = new Map<string, { productId: string; sourceUrl: string; name: string; row: Record<string, unknown> }>();
  for (const item of value.slice(0, 30)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const sourceUrl = directProductUrl(provider, row.url);
    const name = typeof row.title === "string" ? row.title.trim().slice(0, 500) : "";
    if (!sourceUrl || !name) continue;
    const url = new URL(sourceUrl);
    const productId = provider === "jd" ? url.pathname.slice(1, -5) : url.searchParams.get(provider === "pdd" ? "goods_id" : "id")!;
    const previous = candidates.get(productId)?.row.price;
    if (typeof previous === "number" && Number.isFinite(previous) && previous > 0
      && !(typeof row.price === "number" && Number.isFinite(row.price) && row.price > 0)) continue;
    candidates.set(productId, { productId, sourceUrl, name, row });
  }
  return [...candidates.values()];
}

export function normalizeBrowserProducts(value: unknown, provider: ProductProvider, detailVerified = false): AffiliateProduct[] {
  const products = new Map<string, AffiliateProduct>();
  for (const { row, sourceUrl, name, productId } of browserCandidates(value, provider)) {
    const price = row.price;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    products.set(productId, {
      provider, productId, name, price: Math.round(price * 100) / 100,
      sourceUrl, sourceKind: "browser", detailVerified, affiliate: false, hasCoupon: false,
      capturedAt: new Date().toISOString(),
      ...(typeof row.shopName === "string" ? { shopName: row.shopName.slice(0, 100) } : {}),
      ...(typeof row.imageUrl === "string" && /^https:\/\//.test(row.imageUrl) ? { imageUrl: row.imageUrl.slice(0, 2000) } : {}),
    });
  }
  return [...products.values()];
}

export function createBrowserCommerceNode(fetchImpl: typeof fetch) {
  return defineNode({
    type: "browser_commerce", typeVersion: "1.0.0", title: "商城商品直接采集",
    description: "使用本机商城登录会话，采集拼多多、京东或淘宝商品及原始链接。",
    capabilities: { supportsCancel: true, requiredPermissions: ["network.http"] },
    config: z.object({ maxQueries: z.number().int().min(1).max(4).default(4) }),
    ports: [
      { id: "plan", direction: "input", kind: "data", label: "查询计划" },
      { id: "queries", direction: "output", kind: "data", label: "已执行查询" },
      { id: "products", direction: "output", kind: "data", label: "商城商品" },
      { id: "errors", direction: "output", kind: "data", label: "采集状态" },
      { id: "telemetry", direction: "output", kind: "data", label: "检索遥测" },
    ],
    validateInput: false,
    async run({ input, ctx, config }) {
      const selected = ctx.variables.getString(SHOPPING_PLATFORM_VARIABLE) ?? "pdd";
      const provider = isShoppingPlatform(selected) ? selected : undefined;
      const queries = readQueries(input.plan, config.maxQueries ?? 4);
      const products: AffiliateProduct[] = [];
      const errors: string[] = [];
      const telemetry: AffiliateSearchTelemetry[] = [];
      let pages: BrowserPageDiagnostic[] = [];
      const collect = async (body: Record<string, unknown>): Promise<PageResult> => {
        const phase = body.url ? "detail" : "search";
        const page: BrowserPageDiagnostic = { phase, status: "native_error" };
        pages.push(page);
        const response = await fetchImpl(BROWSER_COMMERCE_ENDPOINT, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, ...body }), signal: ctx.signal,
        });
        if (!response.ok) throw new Error("本机商品浏览器不可用");
        const result = await response.json() as PageResult;
        if (result && typeof result === "object") Object.assign(page, pageDiagnostic(result, phase));
        if (!result || !["ok", "empty", ...(body.url ? ["unavailable", "parser_unmatched"] : [])].includes(result.status)) {
          throw new Error(`${phase === "search" ? "搜索页" : "详情页"}：${STATUS_MESSAGES[result?.status] ?? "采集失败，未返回有效商品数据"}`);
        }
        return result;
      };
      if (!provider) errors.push("商品服务不可用：请选择拼多多、京东或淘宝");
      else for (const query of queries) {
        ctx.signal.throwIfAborted();
        pages = [];
        let foundCount = 0;
        const candidates: NonNullable<AffiliateSearchTelemetry["browserCandidates"]> = [];
        let accepted = 0;
        try {
          const result = await collect({ keyword: query.keyword });
          // Search cards without a price still identify candidates; only priced details become products.
          const found = browserCandidates(result.products, provider);
          foundCount = found.length;
          // Card titles rank leads; they cannot prove which SKU a detail price belongs to.
          const compact = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s_-]/g, "");
          const ranked = found.map((product) => {
            const hints: string[] = [];
            if (hasAmbiguousModelPrice(query.partType, product.name)) hints.push("multiple_models_in_search_title");
            for (const term of query.negativeTerms ?? []) {
              if (product.name.toLowerCase().includes(term.toLowerCase())) hints.push(`search_title_term:${term}`);
            }
            const identity = matchesCommerceIdentity(query.partType, product.name, query.modelAnchors, query.keyword, false);
            if (!identity) hints.push("search_identity_uncertain");
            const anchors = query.modelAnchors ?? [];
            const hits = anchors.filter((anchor) => compact(product.name).includes(compact(anchor))).length;
            const score = (identity ? 8 : 0) + (anchors.length ? 4 * hits / anchors.length : 0)
              + (matchesCommerceIdentity(query.partType, product.name, anchors, query.keyword) ? 1 : 0)
              - Math.min(2, hints.length);
            return { product, hints, score };
          }).sort((a, b) => b.score - a.score);
          ranked.forEach(({ product, hints }, index) => candidates.push({
            productId: product.productId, title: product.name, rank: index + 1, hints,
            outcome: index < 4 ? "detail_pending" : "not_visited_budget",
          }));
          for (const [index, { product }] of ranked.slice(0, 4).entries()) {
            candidates[index]!.outcome = "detail_failed";
            const detail = await collect({ url: product.sourceUrl });
            candidates[index]!.outcome = "detail_unresolved";
            if (detail.status !== "ok") continue;
            const verified = normalizeBrowserProducts(detail.products, provider, true).find((item) => item.productId === product.productId);
            if (!verified) continue;
            candidates[index]!.outcome = "detail_priced";
            products.push({ ...verified, queryId: query.queryId, slotId: query.slotId,
              ...(query.coveredSlotIds ? { coveredSlotIds: query.coveredSlotIds } : {}),
              ...(query.partType ? { partType: query.partType } : {}) });
            accepted++;
          }
        } catch (cause) {
          ctx.signal.throwIfAborted();
          errors.push(`商品服务不可用：${cause instanceof Error ? cause.message : "浏览器采集失败"}`);
          break; // Login/verification is a provider failure, not a reason to try forty keywords.
        } finally {
          telemetry.push({ provider, sourceKind: "browser", keyword: query.keyword,
            ...(query.queryId ? { queryId: query.queryId } : {}), ...(query.slotId ? { slotId: query.slotId } : {}),
            providerRawCount: foundCount, structurallyValidCount: foundCount, acceptedCount: accepted,
            rejectedByPrice: 0, rejectedByCategory: 0, rejectedByModel: 0,
            browserPages: pages, browserCandidates: candidates });
        }
      }
      return { kind: "success" as const, outputs: { out: null, queries, products, errors, telemetry } };
    },
  });
}

export function createComputerProductLinksNode() {
  return defineNode({
    type: "computer_product_links", typeVersion: "1.0.0", title: "确认商品原始链接",
    config: z.object({}), validateInput: false,
    ports: [
      { id: "selection", direction: "input", kind: "data", label: "最终选择" },
      { id: "products", direction: "output", kind: "data", label: "商品链接" },
      { id: "state", direction: "output", kind: "data", label: "状态" },
      { id: "errors", direction: "output", kind: "data", label: "链接错误" },
    ],
    async run({ input }) {
      const selection = input.selection as { shortlist?: AffiliateProduct[]; state?: Record<string, unknown> } | undefined;
      const products = (selection?.shortlist ?? []).filter((item) => productPurchaseUrl(item));
      const linked = new Set(products.flatMap((product) => product.coveredSlotIds ?? [product.slotId])).size;
      const state = selection?.state;
      const coverage = state?.coverage as Record<string, unknown> | undefined;
      return { kind: "success" as const, outputs: { out: null, products,
        state: state ? { ...state, coverage: { ...coverage, links: { verified: linked } } } : null, errors: [] } };
    },
  });
}
