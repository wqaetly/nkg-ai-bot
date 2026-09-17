/** Low-level affiliate API adapter used by the affiliate_commerce Flow node. */

export type CommerceProvider = "jd" | "pdd";

export const DEFAULT_COMMERCE_PROVIDER: CommerceProvider = "pdd";

export interface JdAffiliateConfig {
  appKeyRef: string;
  secretKeyRef: string;
  pid: string;
  siteId: string;
  positionId: string;
}

export interface PddAffiliateConfig {
  clientIdRef: string;
  clientSecretRef: string;
  accessTokenRef: string;
  refreshTokenRef?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  pid: string;
}

export interface AffiliateCommerceConfig {
  enabled: boolean;
  selectedProvider: CommerceProvider;
  jd?: JdAffiliateConfig;
  pdd?: PddAffiliateConfig;
}

export interface AffiliateProductQuery {
  keyword: string;
  minPrice?: number;
  maxPrice?: number;
  count?: number;
  /** Stable plan metadata keeps parallel results attached to the slot that
   * requested them. Commerce providers can ignore these fields. */
  queryId?: string;
  slotId?: string;
  coveredSlotIds?: string[];
  partType?: string;
  utilityScore?: number;
  requiredSpecs?: Record<string, unknown>;
  /** Desired blueprint specs are never evidence about the returned product. */
  plannedSpecs?: Record<string, unknown>;
  evidenceRefs?: string[];
  /** Computer-advisor discovery metadata. Generic commerce callers may omit it. */
  stage?: "market_discovery" | "market_confirmation" | "exact_model" | "model_family" | "spec_fallback" | "approved_alternative";
  modelAnchors?: string[];
  categoryAnchors?: string[];
  negativeTerms?: string[];
  attempt?: number;
  discoveryMode?: "unbounded";
}

export interface NormalizedAffiliateProductQuery {
  keyword: string;
  count: number;
  minPrice?: number;
  maxPrice?: number;
  queryId?: string;
  slotId?: string;
  coveredSlotIds?: string[];
  partType?: string;
  utilityScore?: number;
  requiredSpecs?: Record<string, unknown>;
  /** Desired blueprint specs are kept separate from facts about the listing. */
  plannedSpecs?: Record<string, unknown>;
  evidenceRefs?: string[];
  stage?: AffiliateProductQuery["stage"];
  modelAnchors?: string[];
  categoryAnchors?: string[];
  negativeTerms?: string[];
  attempt?: number;
  discoveryMode?: "unbounded";
}

export interface AffiliateProduct {
  provider: CommerceProvider;
  productId: string;
  name: string;
  price: number;
  couponPrice?: number;
  shopName?: string;
  brand?: string;
  imageUrl?: string;
  promotionUrl?: string;
  /** Provider material retained only so a later, isolated promotion step can resolve a link. */
  sourceUrl?: string;
  searchId?: string;
  salesCount?: number;
  rating?: number;
  hasCoupon: boolean;
  capturedAt: string;
  affiliate: true;
  queryId?: string;
  slotId?: string;
  coveredSlotIds?: string[];
  partType?: string;
  utilityScore?: number;
  requiredSpecs?: Record<string, unknown>;
  /** Desired blueprint specs are kept separate from facts about the listing. */
  plannedSpecs?: Record<string, unknown>;
  /** Product facts extracted from a trusted provider/catalog response. */
  observedSpecs?: Record<string, unknown>;
  observedSpecSources?: string[];
  evidenceRefs?: string[];
  candidateRank?: number;
}

export type JdAffiliateCredentials = {
  provider: "jd";
  appKey: string;
  secretKey: string;
};

export type PddAffiliateCredentials = {
  provider: "pdd";
  clientId: string;
  clientSecret: string;
  accessToken: string;
};

export type AffiliateCredentials = JdAffiliateCredentials | PddAffiliateCredentials;

export interface AffiliateSearchOptions {
  signal?: AbortSignal;
  now?: Date;
  /** Compliance-sensitive PDD path for a genuinely new/unlogged customer.
   * Never infer or enable this flag globally. */
  pddNewCustomer?: boolean;
  /** Defaults to true for backwards compatibility. Computer-advisor V4 discovers
   * candidates first and resolves promotion links only after optimization. */
  resolvePromotion?: boolean;
  onTelemetry?: (telemetry: AffiliateSearchTelemetry) => void;
}

export interface AffiliateSearchTelemetry {
  queryId?: string;
  slotId?: string;
  partType?: string;
  stage?: AffiliateProductQuery["stage"];
  attempt?: number;
  keyword: string;
  provider: CommerceProvider;
  providerRawCount: number;
  structurallyValidCount: number;
  rejectedByCategory: number;
  rejectedByModel: number;
  rejectedByPrice: number;
  acceptedCount: number;
}

export interface PddAccessTokenResult {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

const JD_API_URL = "https://api.jd.com/routerjson";
const PDD_API_URL = "https://gw-api.pinduoduo.com/api/router";

/** Exchanges the short-lived authorization code returned by Pinduoduo for
 * the initial access/refresh token pair. The caller owns persistence. */
export async function createPddAccessToken(
  clientId: string,
  clientSecret: string,
  code: string,
  fetchImpl: typeof globalThis.fetch,
  options: AffiliateSearchOptions = {},
): Promise<PddAccessTokenResult> {
  const now = options.now ?? new Date();
  const parameters: Record<string, string> = {
    type: "pdd.pop.auth.token.create",
    client_id: clientId,
    timestamp: String(Math.floor(now.getTime() / 1000)),
    data_type: "JSON",
    code,
  };
  parameters.sign = signParameters(parameters, clientSecret);
  const response = await fetchImpl(withQuery(PDD_API_URL, parameters), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`拼多多 Access Token 获取失败：HTTP ${response.status}`);
  const payload = await response.json() as PddTokenCreateEnvelope;
  if (payload.error_response) {
    throw new Error(`拼多多 Access Token 获取失败：${safeExternalMessage(payload.error_response.error_msg)}`);
  }
  const result = payload.pop_auth_token_create_response;
  if (!result?.access_token) throw new Error("拼多多 Access Token 获取返回格式无效");
  return pddAccessTokenResult(result, now);
}

/** Refreshes a short-lived Pinduoduo OAuth access token. The refresh token is
 * kept by the caller so this low-level adapter never persists credentials. */
export async function refreshPddAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  fetchImpl: typeof globalThis.fetch,
  options: AffiliateSearchOptions = {},
): Promise<PddAccessTokenResult> {
  const now = options.now ?? new Date();
  const parameters: Record<string, string> = {
    type: "pdd.pop.auth.token.refresh",
    client_id: clientId,
    timestamp: String(Math.floor(now.getTime() / 1000)),
    data_type: "JSON",
    refresh_token: refreshToken,
  };
  parameters.sign = signParameters(parameters, clientSecret);
  const response = await fetchImpl(withQuery(PDD_API_URL, parameters), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`拼多多 Access Token 刷新失败：HTTP ${response.status}`);
  const payload = await response.json() as PddTokenRefreshEnvelope;
  if (payload.error_response) {
    throw new Error(`拼多多 Access Token 刷新失败：${safeExternalMessage(payload.error_response.error_msg)}`);
  }
  const result = payload.pop_auth_token_refresh_response;
  if (!result?.access_token) throw new Error("拼多多 Access Token 刷新返回格式无效");
  return pddAccessTokenResult(result, now);
}

/** Generates the business-platform authorization filing URL required by PDD
 * tool merchants. channel_type=10 is deliberately fixed by contract. */
export async function generatePddAuthorizationUrl(
  config: PddAffiliateConfig,
  credentials: PddAffiliateCredentials,
  fetchImpl: typeof globalThis.fetch,
  options: AffiliateSearchOptions = {},
): Promise<string> {
  const parameters: Record<string, string> = {
    type: "pdd.ddk.oauth.rp.prom.url.generate",
    client_id: credentials.clientId,
    access_token: credentials.accessToken,
    timestamp: String(Math.floor((options.now ?? new Date()).getTime() / 1000)),
    data_type: "JSON",
    p_id_list: JSON.stringify([config.pid]),
    channel_type: "10",
    generate_short_url: "true",
  };
  parameters.sign = signParameters(parameters, credentials.clientSecret);
  const response = await fetchImpl(withQuery(PDD_API_URL, parameters), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`拼多多授权备案链接生成失败：HTTP ${response.status}`);
  const payload = await response.json() as PddResourcePromotionEnvelope;
  if (payload.error_response) {
    throw new Error(`拼多多授权备案链接生成失败：${safeExternalMessage(payload.error_response.error_msg)}`);
  }
  const responseBody = payload.rp_promotion_url_generate_response
    ?? payload.rp_prom_url_generate_response;
  const link = responseBody?.url_list?.[0] ?? responseBody?.resource_list?.[0];
  const url = link?.short_url ?? link?.url ?? link?.mobile_short_url ?? link?.mobile_url;
  if (!url) throw new Error("拼多多授权备案链接返回格式无效");
  return requireHttpUrl(url, "拼多多授权备案链接");
}

export async function searchAffiliateProducts(
  config: AffiliateCommerceConfig,
  credentials: AffiliateCredentials,
  rawQuery: AffiliateProductQuery,
  fetchImpl: typeof globalThis.fetch,
  options: AffiliateSearchOptions = {},
): Promise<AffiliateProduct[]> {
  const query = normalizeProductQuery(rawQuery);
  if (config.selectedProvider !== credentials.provider) {
    throw new Error("电商平台配置与凭据不匹配");
  }
  if (credentials.provider === "jd") {
    if (!config.jd) throw new Error("京东联盟配置不完整");
    return searchJd(config.jd, credentials, query, fetchImpl, options);
  }
  if (!config.pdd) throw new Error("拼多多联盟配置不完整");
  return searchPdd(config.pdd, credentials, query, fetchImpl, options);
}

/** Resolve a promotion URL only after a candidate has survived semantic and
 * budget selection. A failure here is isolated to this product. */
export async function resolveAffiliateProductPromotion(
  config: AffiliateCommerceConfig,
  credentials: AffiliateCredentials,
  product: AffiliateProduct,
  fetchImpl: typeof globalThis.fetch,
  options: AffiliateSearchOptions = {},
): Promise<string> {
  if (product.promotionUrl) return requireHttpUrl(product.promotionUrl, "联盟推广链接");
  if (config.selectedProvider !== credentials.provider || product.provider !== credentials.provider) {
    throw new Error("商品平台与联盟凭据不匹配");
  }
  if (credentials.provider === "jd") {
    if (!config.jd) throw new Error("京东联盟配置不完整");
    const materialUrl = product.sourceUrl || `https://item.jd.com/${encodeURIComponent(product.productId)}.html`;
    return generateJdPromotionUrl(config.jd, credentials, materialUrl, fetchImpl, options);
  }
  if (!config.pdd) throw new Error("拼多多联盟配置不完整");
  return generatePddPromotionUrl(
    config.pdd,
    credentials,
    product.productId,
    product.searchId,
    fetchImpl,
    options,
  );
}

export function normalizeProductQuery(
  query: AffiliateProductQuery,
): NormalizedAffiliateProductQuery {
  const keyword = query.keyword.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!keyword) throw new Error("商品搜索关键词不能为空");
  const minPrice = finitePrice(query.minPrice);
  const maxPrice = finitePrice(query.maxPrice);
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    throw new Error("商品最低价不能高于最高价");
  }
  return {
    keyword,
    count: Math.max(1, Math.min(Math.floor(query.count ?? 2), 5)),
    ...(minPrice !== undefined ? { minPrice } : {}),
    ...(maxPrice !== undefined ? { maxPrice } : {}),
    ...(cleanIdentifier(query.queryId) ? { queryId: cleanIdentifier(query.queryId) } : {}),
    ...(cleanIdentifier(query.slotId) ? { slotId: cleanIdentifier(query.slotId) } : {}),
    ...(readStringList(query.coveredSlotIds, 4).length > 0 ? { coveredSlotIds: readStringList(query.coveredSlotIds, 4) } : {}),
    ...(cleanIdentifier(query.partType) ? { partType: cleanIdentifier(query.partType) } : {}),
    ...(finiteScore(query.utilityScore) !== undefined ? { utilityScore: finiteScore(query.utilityScore) } : {}),
    ...(isPlainRecord(query.requiredSpecs) ? { requiredSpecs: query.requiredSpecs } : {}),
    ...(isPlainRecord(query.plannedSpecs) ? { plannedSpecs: query.plannedSpecs } : {}),
    ...(readEvidenceRefs(query.evidenceRefs).length > 0 ? { evidenceRefs: readEvidenceRefs(query.evidenceRefs) } : {}),
    ...(readQueryStage(query.stage) ? { stage: readQueryStage(query.stage) } : {}),
    ...(readStringList(query.modelAnchors, 12).length > 0 ? { modelAnchors: readStringList(query.modelAnchors, 12) } : {}),
    ...(readStringList(query.categoryAnchors, 12).length > 0 ? { categoryAnchors: readStringList(query.categoryAnchors, 12) } : {}),
    ...(readStringList(query.negativeTerms, 20).length > 0 ? { negativeTerms: readStringList(query.negativeTerms, 20) } : {}),
    ...(positiveInteger(query.attempt) !== undefined ? { attempt: positiveInteger(query.attempt) } : {}),
    ...(query.discoveryMode === "unbounded" ? { discoveryMode: "unbounded" as const } : {}),
  };
}

function readQueryStage(value: unknown): AffiliateProductQuery["stage"] | undefined {
  return value === "market_discovery" || value === "market_confirmation"
    || value === "exact_model" || value === "model_family" || value === "spec_fallback" || value === "approved_alternative"
    ? value
    : undefined;
}

function readStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, limit);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function searchTelemetry(
  query: NormalizedAffiliateProductQuery,
  provider: CommerceProvider,
  counts: Pick<AffiliateSearchTelemetry,
    "providerRawCount" | "structurallyValidCount" | "rejectedByCategory" | "rejectedByModel" | "rejectedByPrice" | "acceptedCount">,
): AffiliateSearchTelemetry {
  return {
    ...(query.queryId ? { queryId: query.queryId } : {}),
    ...(query.slotId ? { slotId: query.slotId } : {}),
    ...(query.partType ? { partType: query.partType } : {}),
    ...(query.stage ? { stage: query.stage } : {}),
    ...(query.attempt ? { attempt: query.attempt } : {}),
    keyword: query.keyword,
    provider,
    ...counts,
  };
}

function cleanIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[^a-zA-Z0-9_.:-]+/g, "-").slice(0, 80);
  return normalized || undefined;
}

function finiteScore(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readEvidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, 6);
}

async function searchJd(
  config: JdAffiliateConfig,
  credentials: JdAffiliateCredentials,
  query: ReturnType<typeof normalizeProductQuery>,
  fetchImpl: typeof globalThis.fetch,
  options: AffiliateSearchOptions,
): Promise<AffiliateProduct[]> {
  const paramJson = JSON.stringify({
    keyword: query.keyword,
    pageIndex: 1,
    pageSize: 30,
    sceneId: 1,
    ...(query.minPrice !== undefined ? { pricefrom: query.minPrice } : {}),
    ...(query.maxPrice !== undefined ? { priceto: query.maxPrice } : {}),
    sortName: "inOrderCount30Days",
    sort: "desc",
    pid: config.pid,
    fields: "videoInfo,hotWords,similar,documentInfo",
  });
  const system = jdSystemParams("jd.union.open.goods.query", credentials.appKey, options.now);
  system.param_json = paramJson;
  system.sign = signParameters(system, credentials.secretKey);
  const response = await fetchImpl(JD_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(system),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`京东联盟商品搜索失败：HTTP ${response.status}`);
  const payload = await response.json() as JdGoodsEnvelope;
  const encoded = payload.jd_union_open_goods_query_responce?.queryResult;
  if (!encoded) throw new Error("京东联盟商品搜索返回格式无效");
  const result = JSON.parse(encoded) as JdGoodsResult;
  if (Number(result.code) !== 200) {
    throw new Error(`京东联盟商品搜索失败：${safeExternalMessage(result.message)}`);
  }
  const rawGoods = result.data ?? [];
  const structurallyValid = rawGoods
    .map((entry) => entry.goodsResp)
    .filter((entry): entry is JdGoods => Boolean(entry?.skuId && entry.skuName && entry.materialUrl));
  const inRange = structurallyValid.filter((entry) => inPriceRange(readJdEffectivePrice(entry), query));
  const evaluated = inRange.map((entry) => ({
    entry,
    match: evaluateAffiliateProductMatch(`${entry.skuName} ${entry.brandName ?? ""}`, query),
  }));
  const goods = evaluated
    .filter(({ match }) => match.matched)
    .map(({ entry }) => ({ entry, score: jdProductScore(entry, query) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, query.count);
  options.onTelemetry?.(searchTelemetry(query, "jd", {
    providerRawCount: rawGoods.length,
    structurallyValidCount: structurallyValid.length,
    rejectedByPrice: structurallyValid.length - inRange.length,
    rejectedByCategory: evaluated.filter(({ match }) => !match.categoryMatched).length,
    rejectedByModel: evaluated.filter(({ match }) => match.categoryMatched && !match.modelMatched).length,
    acceptedCount: goods.length,
  }));
  const capturedAt = (options.now ?? new Date()).toISOString();
  return Promise.all(goods.map(async ({ entry }) => {
    const promotionUrl = options.resolvePromotion === false
      ? undefined
      : await generateJdPromotionUrl(config, credentials, entry.materialUrl, fetchImpl, options);
    return {
      provider: "jd" as const,
      productId: String(entry.skuId),
      name: entry.skuName,
      price: readJdListPrice(entry),
      ...(readJdCouponPrice(entry) !== undefined
        ? { couponPrice: readJdCouponPrice(entry) }
        : {}),
      ...(entry.shopInfo?.shopName ? { shopName: entry.shopInfo.shopName } : {}),
      ...(entry.brandName ? { brand: entry.brandName } : {}),
      ...(readJdImage(entry) ? { imageUrl: readJdImage(entry) } : {}),
      sourceUrl: entry.materialUrl,
      ...(promotionUrl ? { promotionUrl } : {}),
      ...(positiveNumber(entry.inOrderCount30Days) !== undefined ? { salesCount: positiveNumber(entry.inOrderCount30Days) } : {}),
      ...(positiveNumber(entry.goodCommentsShare) !== undefined ? { rating: positiveNumber(entry.goodCommentsShare) } : {}),
      hasCoupon: Boolean(entry.couponInfo?.couponList?.coupon),
      capturedAt,
      affiliate: true as const,
    };
  }));
}

async function generateJdPromotionUrl(
  config: JdAffiliateConfig,
  credentials: JdAffiliateCredentials,
  materialUrl: string,
  fetchImpl: typeof globalThis.fetch,
  options: AffiliateSearchOptions,
): Promise<string> {
  const system = jdSystemParams("jd.union.open.promotion.common.get", credentials.appKey, options.now);
  system.param_json = JSON.stringify({
    materialId: materialUrl,
    siteId: config.siteId,
    positionId: Number(config.positionId),
    sceneId: 1,
  });
  system.sign = signParameters(system, credentials.secretKey);
  const response = await fetchImpl(JD_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(system),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`京东联盟转链失败：HTTP ${response.status}`);
  const payload = await response.json() as JdPromotionEnvelope;
  const encoded = payload.jd_union_open_promotion_common_get_responce?.getResult;
  if (!encoded) throw new Error("京东联盟转链返回格式无效");
  const result = JSON.parse(encoded) as JdPromotionResult;
  if (Number(result.code) !== 200 || !result.data?.clickURL) {
    throw new Error(`京东联盟转链失败：${safeExternalMessage(result.message)}`);
  }
  return requireHttpUrl(result.data.clickURL, "京东联盟推广链接");
}

async function searchPdd(
  config: PddAffiliateConfig,
  credentials: PddAffiliateCredentials,
  query: ReturnType<typeof normalizeProductQuery>,
  fetchImpl: typeof globalThis.fetch,
  options: AffiliateSearchOptions,
): Promise<AffiliateProduct[]> {
  const parameters: Record<string, string> = {
    type: options.pddNewCustomer ? "pdd.ddk.goods.search" : "pdd.ddk.oauth.goods.search",
    client_id: credentials.clientId,
    ...(!options.pddNewCustomer ? { access_token: credentials.accessToken } : {}),
    timestamp: String(Math.floor((options.now ?? new Date()).getTime() / 1000)),
    data_type: "JSON",
    keyword: query.keyword,
    page: "1",
    page_size: "30",
    sort_type: "0",
    with_coupon: "false",
    pid: config.pid,
    ...(options.pddNewCustomer ? { custom_parameters: JSON.stringify({ new: 1 }) } : {}),
  };
  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    parameters.range_list = JSON.stringify([{
      range_id: 1,
      range_from: Math.round((query.minPrice ?? 0) * 100),
      range_to: Math.round((query.maxPrice ?? 999_999) * 100),
    }]);
  }
  parameters.sign = signParameters(parameters, credentials.clientSecret);
  const response = await fetchImpl(withQuery(PDD_API_URL, parameters), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`拼多多联盟商品搜索失败：HTTP ${response.status}`);
  const payload = await response.json() as PddGoodsEnvelope;
  if (payload.error_response) {
    throw new Error(`拼多多联盟商品搜索失败：${safeExternalMessage(payload.error_response.error_msg)}`);
  }
  const data = payload.goods_search_response;
  const rawGoods = data?.goods_list ?? [];
  const structurallyValid = rawGoods
    .filter((entry) => entry.goods_sign && entry.goods_name && entry.min_group_price > 0);
  const inRange = structurallyValid.filter((entry) => inPriceRange(readPddCouponPrice(entry), query));
  const evaluated = inRange.map((entry) => ({
    entry,
    match: evaluateAffiliateProductMatch(`${entry.goods_name} ${entry.brand_name ?? ""}`, query),
  }));
  const goods = evaluated
    .filter(({ match }) => match.matched)
    .map(({ entry }) => ({ entry, score: pddProductScore(entry, query) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, query.count);
  options.onTelemetry?.(searchTelemetry(query, "pdd", {
    providerRawCount: rawGoods.length,
    structurallyValidCount: structurallyValid.length,
    rejectedByPrice: structurallyValid.length - inRange.length,
    rejectedByCategory: evaluated.filter(({ match }) => !match.categoryMatched).length,
    rejectedByModel: evaluated.filter(({ match }) => match.categoryMatched && !match.modelMatched).length,
    acceptedCount: goods.length,
  }));
  const capturedAt = (options.now ?? new Date()).toISOString();
  return Promise.all(goods.map(async ({ entry }) => {
    const searchId = entry.search_id ?? data?.search_id;
    const promotionUrl = options.resolvePromotion === false
      ? undefined
      : await generatePddPromotionUrl(config, credentials, entry.goods_sign, searchId, fetchImpl, options);
    return {
      provider: "pdd" as const,
      productId: entry.goods_sign,
      name: entry.goods_name,
      price: entry.min_group_price / 100,
      ...(entry.has_coupon ? { couponPrice: readPddCouponPrice(entry) } : {}),
      ...(entry.mall_name ? { shopName: entry.mall_name } : {}),
      ...(entry.brand_name ? { brand: entry.brand_name } : {}),
      ...(entry.goods_image_url || entry.goods_thumbnail_url
        ? { imageUrl: entry.goods_image_url ?? entry.goods_thumbnail_url }
        : {}),
      ...(searchId ? { searchId } : {}),
      ...(promotionUrl ? { promotionUrl } : {}),
      ...(parseSalesCount(entry.sales_tip) !== undefined ? { salesCount: parseSalesCount(entry.sales_tip) } : {}),
      hasCoupon: entry.has_coupon === true,
      capturedAt,
      affiliate: true as const,
    };
  }));
}

async function generatePddPromotionUrl(
  config: PddAffiliateConfig,
  credentials: PddAffiliateCredentials,
  goodsSign: string,
  searchId: string | undefined,
  fetchImpl: typeof globalThis.fetch,
  options: AffiliateSearchOptions,
): Promise<string> {
  const parameters: Record<string, string> = {
    type: options.pddNewCustomer
      ? "pdd.ddk.goods.promotion.url.generate"
      : "pdd.ddk.oauth.goods.prom.url.generate",
    client_id: credentials.clientId,
    ...(!options.pddNewCustomer ? { access_token: credentials.accessToken } : {}),
    timestamp: String(Math.floor((options.now ?? new Date()).getTime() / 1000)),
    data_type: "JSON",
    p_id: config.pid,
    goods_sign_list: JSON.stringify([goodsSign]),
    generate_short_url: "true",
    ...(searchId ? { search_id: searchId } : {}),
  };
  parameters.sign = signParameters(parameters, credentials.clientSecret);
  const response = await fetchImpl(withQuery(PDD_API_URL, parameters), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`拼多多联盟转链失败：HTTP ${response.status}`);
  const payload = await response.json() as PddPromotionEnvelope;
  if (payload.error_response) {
    throw new Error(`拼多多联盟转链失败：${safeExternalMessage(payload.error_response.error_msg)}`);
  }
  const link = payload.goods_promotion_url_generate_response?.goods_promotion_url_list?.[0];
  const url = link?.short_url ?? link?.url ?? link?.mobile_short_url ?? link?.mobile_url;
  if (!url) throw new Error("拼多多联盟转链返回格式无效");
  return requireHttpUrl(url, "拼多多联盟推广链接");
}

export function signParameters(parameters: Record<string, string>, secret: string): string {
  const content = Object.entries(parameters)
    .filter(([key, value]) => key !== "sign" && value !== "")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}${value}`)
    .join("");
  return md5Hex(`${secret}${content}${secret}`).toUpperCase();
}

function md5Hex(value: string): string {
  const source = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const bitLength = BigInt(source.length) * 8n;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Number(bitLength & 0xffff_ffffn), true);
  view.setUint32(paddedLength - 4, Number(bitLength >> 32n), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const constants = Array.from({ length: 64 }, (_, index) =>
    Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_0000_0000) >>> 0);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let word: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        word = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        word = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        word = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        word = (7 * index) % 16;
      }
      const nextD = d;
      d = c;
      c = b;
      const mixed = (a + f + constants[index]! + view.getUint32(offset + word * 4, true)) >>> 0;
      b = (b + rotateLeft(mixed, shifts[index]!)) >>> 0;
      a = nextD;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return [a0, b0, c0, d0]
    .flatMap((word) => [0, 8, 16, 24].map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, "0")))
    .join("");
}

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function jdSystemParams(method: string, appKey: string, now = new Date()): Record<string, string> {
  return {
    method,
    app_key: appKey,
    timestamp: formatJdTimestamp(now),
    format: "json",
    v: "1.0",
    sign_method: "md5",
  };
}

function formatJdTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function jdProductScore(goods: JdGoods, query: NormalizedAffiliateProductQuery): number {
  const title = `${goods.skuName} ${goods.brandName ?? ""}`;
  if (!isAffiliateProductMatch(title, query)) return 0;
  const relevance = relevanceScore(title, query.keyword);
  const rating = Math.max(0, Math.min(Number(goods.goodCommentsShare ?? 0) / 100, 1));
  const sales = Math.min(Number(goods.inOrderCount30Days ?? 0) / 10_000, 1);
  const selfOperated = goods.owner === "g" ? 1 : 0;
  const coupon = goods.couponInfo?.couponList?.coupon ? 1 : 0;
  return relevance * 60 + rating * 20 + sales * 10 + selfOperated * 7 + coupon * 3;
}

function pddProductScore(goods: PddGoods, query: NormalizedAffiliateProductQuery): number {
  const title = `${goods.goods_name} ${goods.brand_name ?? ""}`;
  if (!isAffiliateProductMatch(title, query)) return 0;
  const relevance = relevanceScore(title, query.keyword);
  const sales = Math.min((parseSalesCount(goods.sales_tip) ?? 0) / 10_000, 1);
  const merchant = [3, 4, 5].includes(goods.merchant_type ?? 0) ? 1 : 0;
  const service = [goods.serv_txt, goods.lgst_txt, goods.desc_txt].filter((value) => value === "高").length / 3;
  return relevance * 70 + sales * 12 + merchant * 8 + service * 7 + (goods.has_coupon ? 3 : 0);
}

function relevanceScore(title: string, keyword: string): number {
  const normalizedTitle = normalizeSearchText(title);
  const normalizedKeyword = normalizeSearchText(keyword);
  const tokens = [...new Set([
    ...normalizedKeyword.match(/[a-z]+\d+[a-z0-9-]*/g) ?? [],
    ...normalizedKeyword.match(/\d{3,}[a-z]*/g) ?? [],
    ...normalizedKeyword.split(" ").filter((token) => token.length >= 2),
  ])].filter((token) => !["显卡", "主板", "内存", "硬盘", "电源", "机箱", "散热", "笔记本"].includes(token));
  if (tokens.length === 0) return normalizedTitle.includes(normalizedKeyword) ? 1 : 0;
  const matches = tokens.filter((token) => normalizedTitle.includes(token)).length;
  return matches / tokens.length;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}-]+/gu, " ").trim();
}

function readJdEffectivePrice(goods: JdGoods): number {
  return finitePrice(goods.priceInfo?.lowestCouponPrice)
    ?? finitePrice(goods.priceInfo?.lowestPrice)
    ?? finitePrice(goods.priceInfo?.price)
    ?? 0;
}

/**
 * Affiliate search is fuzzy and can return accessories or a different product
 * category that happens to share a capacity/size token.  Keep those results
 * out before a promotion link is generated or a budget slot is assigned.
 */
export function isAffiliateProductMatch(
  title: string,
  query: Pick<NormalizedAffiliateProductQuery, "keyword" | "partType" | "slotId" | "requiredSpecs" | "stage" | "modelAnchors" | "negativeTerms">,
): boolean {
  return evaluateAffiliateProductMatch(title, query).matched;
}

export interface AffiliateProductMatchEvaluation {
  matched: boolean;
  categoryMatched: boolean;
  modelMatched: boolean;
  relevance: number;
  rejectionReasons: Array<"empty_text" | "category_mismatch" | "negative_term" | "model_mismatch" | "low_relevance">;
}

export function evaluateAffiliateProductMatch(
  title: string,
  query: Pick<NormalizedAffiliateProductQuery, "keyword" | "partType" | "slotId" | "requiredSpecs" | "stage" | "modelAnchors" | "negativeTerms">,
): AffiliateProductMatchEvaluation {
  const normalizedTitle = normalizeSearchText(title);
  const compactTitle = normalizedTitle.replace(/\s+/g, "");
  const normalizedKeyword = normalizeSearchText(query.keyword);
  if (!normalizedTitle || !normalizedKeyword) {
    return { matched: false, categoryMatched: false, modelMatched: false, relevance: 0, rejectionReasons: ["empty_text"] };
  }

  const partType = normalizeCommercePart(query.partType ?? query.slotId);
  const negativeMatched = (query.negativeTerms ?? [])
    .map(normalizeSearchText)
    .filter(Boolean)
    .some((term) => normalizedTitle.includes(term));
  const categoryMatched = !negativeMatched
    && (!partType || matchesPartCategory(normalizedTitle, partType, normalizedKeyword, query.requiredSpecs));

  const explicitAnchors = (query.modelAnchors ?? [])
    .map((value) => normalizeSearchText(value).replace(/\s+/g, ""))
    .filter((value) => value.length >= 2);
  const modelTokens = explicitAnchors.length > 0
    ? explicitAnchors
    : query.stage === "spec_fallback"
      ? []
      : modelIdentityTokens(normalizedKeyword);
  const modelMatched = modelTokens.length === 0
    || modelTokens.some((token) => compactTitle.includes(token.replace(/\s+/g, "")));

  const relevance = relevanceScore(normalizedTitle, normalizedKeyword);
  const requiresModelAnchor = query.stage === "exact_model"
    || query.stage === "model_family"
    || query.stage === "approved_alternative"
    || modelTokens.length > 0;
  const relevanceMatched = relevance >= (partType ? 0.2 : 0.4);
  const rejectionReasons: AffiliateProductMatchEvaluation["rejectionReasons"] = [];
  if (negativeMatched) rejectionReasons.push("negative_term");
  if (!categoryMatched && !negativeMatched) rejectionReasons.push("category_mismatch");
  if (requiresModelAnchor && !modelMatched) rejectionReasons.push("model_mismatch");
  if (!requiresModelAnchor && !relevanceMatched) rejectionReasons.push("low_relevance");
  return {
    matched: categoryMatched && (!requiresModelAnchor ? relevanceMatched : modelMatched),
    categoryMatched,
    modelMatched,
    relevance,
    rejectionReasons,
  };
}

function modelIdentityTokens(keyword: string): string[] {
  const genericSpecs = /^(?:\d+(?:\.\d+)?(?:gb|tb|mhz|hz|w|mm)|ddr[345]|pcie\d*|nvme|usb\d*|m\d*)$/;
  const tokens = keyword.split(" ").flatMap((token) => {
    const matches = token.match(/[\p{L}]*\d+[\p{L}\p{N}-]*/gu) ?? [];
    return matches.length > 0 ? matches : [];
  });
  return [...new Set(tokens
    .map((token) => token.replace(/[^\p{L}\p{N}-]+/gu, ""))
    .filter((token) => token.length >= 3 && !genericSpecs.test(token)))];
}

function normalizeCommercePart(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLocaleLowerCase();
  const aliases: Record<string, string> = {
    cpu: "cpu", cooler: "cooler", motherboard: "motherboard", memory: "memory",
    gpu: "gpu", storage: "storage", psu: "psu", case: "case", monitor: "monitor",
    keyboard: "keyboard", mouse: "mouse", system: "system",
    "处理器": "cpu", "散热": "cooler", "散热器": "cooler", "主板": "motherboard",
    "内存": "memory", "显卡": "gpu", "硬盘": "storage", "固态": "storage",
    "电源": "psu", "机箱": "case", "显示器": "monitor", "键盘": "keyboard",
    "鼠标": "mouse", "整机": "system", "笔记本": "system",
  };
  return normalized ? aliases[normalized] : undefined;
}

function matchesPartCategory(
  title: string,
  partType: string,
  keyword: string,
  requiredSpecs: Record<string, unknown> | undefined,
): boolean {
  const rules: Record<string, { include: RegExp; exclude: RegExp }> = {
    cpu: {
      include: /处理器|\bcpu\b|ryzen|锐龙|酷睿|core\s*i[3579]|至强|xeon|奔腾|赛扬/,
      exclude: /散热|风扇|硅脂|支架|主板|贴纸|保护壳/,
    },
    cooler: {
      include: /散热器|散热|风冷|水冷|冷排|cpu\s*风扇/,
      exclude: /手机|平板|ipad|磁吸|半导体|笔记本散热|硅脂|支架|扣具|风扇罩/,
    },
    motherboard: {
      include: /主板|\b(?:a|b|h|x|z)\d{3}[a-z]*\b/,
      exclude: /挡板|电池|维修|转接卡|扩展卡|测试卡|保护壳/,
    },
    memory: {
      include: /内存条|台式机内存|笔记本内存|\bram\b|\bddr[345]\b/,
      exclude: /内存卡|存储卡|sd卡|tf卡|u盘|读卡器|硬盘/,
    },
    gpu: {
      include: /显卡|graphics|\brtx\s*\d|\bgtx\s*\d|\brx\s*\d|arc\s*[ab]\d/,
      exclude: /显卡支架|显卡延长线|显卡坞|转接线|风扇|散热器|保护壳/,
    },
    storage: {
      include: /固态硬盘|机械硬盘|移动硬盘|\bssd\b|\bnvme\b|\bhdd\b|m\.\s*2/,
      exclude: /移动|便携|外置|usb|硬盘盒|硬盘座|转接盒|转接卡|数据线|保护套|收纳包/,
    },
    psu: {
      include: /电脑电源|台式机电源|全模组电源|半模组电源|\bpsu\b|\d{3,4}w.*电源/,
      exclude: /电源线|适配器|模组线|延长线|测试器|充电器/,
    },
    case: {
      include: /机箱|电脑主机箱/,
      exclude: /机箱风扇|机箱支架|防尘网|侧板|螺丝|提手|收纳包/,
    },
    monitor: {
      include: /显示器|电竞屏|电脑屏幕|\bmonitor\b/,
      exclude: /显示器支架|挂灯|保护膜|屏幕清洁|转接线/,
    },
    keyboard: { include: /键盘|keyboard/, exclude: /键帽|键盘膜|腕托|轴体|数据线/ },
    mouse: { include: /鼠标|mouse/, exclude: /鼠标垫|脚贴|微动|收纳包/ },
    system: {
      include: /台式机|整机|电脑主机|笔记本|游戏本|工作站|一体机/,
      exclude: /支架|保护壳|电脑包|散热垫|键盘膜|贴膜/,
    },
  };
  const rule = rules[partType];
  if (partType === "cpu" && /板u套装|板\s*u\s*套装/.test(keyword)) {
    const hasCpu = /处理器|\bcpu\b|ryzen|锐龙|酷睿|core\s*i[3579]|\bi[3579][ -]?\d{4,5}/.test(title);
    const hasMotherboard = /主板|\b(?:a|b|h|x|z)\d{3}[a-z]*\b/.test(title);
    const accessory = /散热|风扇|硅脂|支架|挡板|维修|转接/.test(title);
    return hasCpu && hasMotherboard && !accessory;
  }
  if (!rule || rule.exclude.test(title)) return false;

  if (partType === "storage") {
    const wantsInternalSsd = /nvme|固态|ssd|m\.\s*2/.test(keyword)
      || ["NVMe", "M.2", "PCIe"].some((value) => Object.values(requiredSpecs ?? {}).some((spec) =>
        typeof spec === "string" && spec.toLocaleLowerCase().includes(value.toLocaleLowerCase())));
    if (wantsInternalSsd && /移动|便携|外置|usb|机械硬盘|\bhdd\b/.test(title)) return false;
  }

  if (partType === "case") {
    const declaredFormFactors = requiredSpecs?.supportedMotherboardFormFactors;
    const formFactors = (Array.isArray(declaredFormFactors)
      ? declaredFormFactors
      : [declaredFormFactors])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ""));
    const requiresAtx = formFactors.includes("atx");
    const explicitlySupportsAtx = /\batx\b/.test(title);
    const compactOnly = /\bmini[\s-]?itx\b|\bitx\b|迷你|17\s*[*x×]\s*17|小\s*1u/.test(title);
    if (requiresAtx && compactOnly && !explicitlySupportsAtx) return false;
  }

  return rule.include.test(title) || modelIdentityTokens(keyword).some((token) =>
    title.replace(/\s+/g, "").includes(token.replace(/\s+/g, "")));
}

function readJdListPrice(goods: JdGoods): number {
  return finitePrice(goods.priceInfo?.price)
    ?? finitePrice(goods.priceInfo?.lowestPrice)
    ?? finitePrice(goods.priceInfo?.lowestCouponPrice)
    ?? 0;
}

function readJdCouponPrice(goods: JdGoods): number | undefined {
  const listPrice = readJdListPrice(goods);
  const couponPrice = finitePrice(goods.priceInfo?.lowestCouponPrice)
    ?? finitePrice(goods.priceInfo?.lowestPrice);
  return couponPrice !== undefined && couponPrice < listPrice ? couponPrice : undefined;
}

function readJdImage(goods: JdGoods): string | undefined {
  if (goods.imageInfo?.whiteImage) return goods.imageInfo.whiteImage;
  const info = goods.imageInfo?.imageList?.urlInfo;
  if (Array.isArray(info)) return typeof info[0]?.url === "string" ? info[0].url : undefined;
  return info && typeof info.url === "string" ? info.url : undefined;
}

function readPddCouponPrice(goods: PddGoods): number {
  return Math.max(0, (goods.min_group_price - (goods.has_coupon ? goods.coupon_discount ?? 0 : 0)) / 100);
}

function inPriceRange(price: number, query: Pick<AffiliateProductQuery, "minPrice" | "maxPrice">): boolean {
  if (price <= 0) return false;
  if (query.minPrice !== undefined && price < query.minPrice) return false;
  if (query.maxPrice !== undefined && price > query.maxPrice) return false;
  return true;
}

function parseSalesCount(value: string | undefined): number | undefined {
  const match = value?.replace(/\+/g, "").match(/([\d.]+)\s*(万)?/);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]) * (match[2] ? 10_000 : 1);
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

function finitePrice(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10_000_000
    ? Math.round(parsed * 100) / 100
    : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function withQuery(baseUrl: string, parameters: Record<string, string>): string {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
}

function requireHttpUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${label}协议无效`);
  return url.toString();
}

function safeExternalMessage(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : "平台未返回错误详情";
}

function pddAccessTokenResult(result: PddTokenPayload, now: Date): PddAccessTokenResult {
  const refreshExpiresIn = result.refresh_token_expires_in ?? result.refresh_expires_in;
  const refreshExpiresAt = result.refresh_token_expires_at ?? result.refresh_expires_at;
  return {
    accessToken: result.access_token!,
    accessTokenExpiresAt: tokenExpiry(now, result.expires_in, result.expires_at, 24 * 60 * 60),
    ...(result.refresh_token ? { refreshToken: result.refresh_token } : {}),
    ...(result.refresh_token || refreshExpiresIn !== undefined || refreshExpiresAt !== undefined
      ? { refreshTokenExpiresAt: tokenExpiry(now, refreshExpiresIn, refreshExpiresAt, 30 * 24 * 60 * 60) }
      : {}),
  };
}

function tokenExpiry(
  now: Date,
  expiresIn: unknown,
  expiresAt: unknown,
  fallbackSeconds: number,
): string {
  const absolute = Number(expiresAt);
  if (Number.isFinite(absolute) && absolute > 0) {
    const milliseconds = absolute > 10_000_000_000 ? absolute : absolute * 1000;
    return new Date(milliseconds).toISOString();
  }
  const seconds = Number(expiresIn);
  return new Date(now.getTime() + (Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds) * 1000)
    .toISOString();
}

type JdGoodsEnvelope = { jd_union_open_goods_query_responce?: { queryResult?: string } };
type JdPromotionEnvelope = { jd_union_open_promotion_common_get_responce?: { getResult?: string } };
type JdGoodsResult = { code?: number | string; message?: string; data?: Array<{ goodsResp?: JdGoods }> };
type JdPromotionResult = { code?: number | string; message?: string; data?: { clickURL?: string } };
type JdGoods = {
  skuId: number | string;
  skuName: string;
  materialUrl: string;
  owner?: string;
  brandName?: string;
  inOrderCount30Days?: number;
  goodCommentsShare?: number;
  priceInfo?: { price?: number; lowestPrice?: number; lowestCouponPrice?: number };
  shopInfo?: { shopName?: string };
  imageInfo?: { whiteImage?: string; imageList?: { urlInfo?: Array<{ url?: string }> | { url?: string } } };
  couponInfo?: { couponList?: { coupon?: unknown } };
};
type PddGoodsEnvelope = {
  goods_search_response?: { goods_list?: PddGoods[]; search_id?: string };
  error_response?: { error_msg?: string };
};
type PddPromotionEnvelope = {
  goods_promotion_url_generate_response?: {
    goods_promotion_url_list?: Array<{
      url?: string;
      short_url?: string;
      mobile_url?: string;
      mobile_short_url?: string;
    }>;
  };
  error_response?: { error_msg?: string };
};
type PddResourcePromotionEnvelope = {
  rp_promotion_url_generate_response?: PddResourcePromotionResponse;
  rp_prom_url_generate_response?: PddResourcePromotionResponse;
  error_response?: { error_msg?: string };
};
type PddResourcePromotionResponse = {
  url_list?: PddPromotionLink[];
  resource_list?: PddPromotionLink[];
};
type PddPromotionLink = {
  url?: string;
  short_url?: string;
  mobile_url?: string;
  mobile_short_url?: string;
};
type PddTokenPayload = {
  access_token?: string;
  expires_in?: number | string;
  expires_at?: number | string;
  refresh_token?: string;
  refresh_token_expires_in?: number | string;
  refresh_token_expires_at?: number | string;
  /** Kept for compatibility with older gateways observed in the field. */
  refresh_expires_in?: number | string;
  refresh_expires_at?: number | string;
};
type PddTokenCreateEnvelope = {
  pop_auth_token_create_response?: PddTokenPayload;
  error_response?: { error_msg?: string };
};
type PddTokenRefreshEnvelope = {
  pop_auth_token_refresh_response?: PddTokenPayload;
  error_response?: { error_msg?: string };
};
type PddGoods = {
  goods_name: string;
  goods_sign: string;
  goods_image_url?: string;
  goods_thumbnail_url?: string;
  min_group_price: number;
  coupon_discount?: number;
  has_coupon?: boolean;
  sales_tip?: string;
  mall_name?: string;
  merchant_type?: number;
  brand_name?: string;
  search_id?: string;
  serv_txt?: string;
  lgst_txt?: string;
  desc_txt?: string;
};
