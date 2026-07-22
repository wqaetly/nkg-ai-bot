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
  promotionUrl: string;
  salesCount?: number;
  rating?: number;
  hasCoupon: boolean;
  capturedAt: string;
  affiliate: true;
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
};

export type AffiliateCredentials = JdAffiliateCredentials | PddAffiliateCredentials;

export interface AffiliateSearchOptions {
  signal?: AbortSignal;
  now?: Date;
}

const JD_API_URL = "https://api.jd.com/routerjson";
const PDD_API_URL = "https://gw-api.pinduoduo.com/api/router";

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

export function normalizeProductQuery(query: AffiliateProductQuery): Required<Pick<AffiliateProductQuery, "keyword" | "count">> & Pick<AffiliateProductQuery, "minPrice" | "maxPrice"> {
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
  };
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
  const goods = (result.data ?? [])
    .map((entry) => entry.goodsResp)
    .filter((entry): entry is JdGoods => Boolean(entry?.skuId && entry.skuName && entry.materialUrl))
    .filter((entry) => inPriceRange(readJdPrice(entry), query))
    .map((entry) => ({ entry, score: jdProductScore(entry, query.keyword) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, query.count);
  const capturedAt = (options.now ?? new Date()).toISOString();
  return Promise.all(goods.map(async ({ entry }) => ({
    provider: "jd" as const,
    productId: String(entry.skuId),
    name: entry.skuName,
    price: readJdPrice(entry),
    ...(finitePrice(entry.priceInfo?.lowestCouponPrice) !== undefined
      ? { couponPrice: finitePrice(entry.priceInfo?.lowestCouponPrice) }
      : {}),
    ...(entry.shopInfo?.shopName ? { shopName: entry.shopInfo.shopName } : {}),
    ...(entry.brandName ? { brand: entry.brandName } : {}),
    ...(readJdImage(entry) ? { imageUrl: readJdImage(entry) } : {}),
    promotionUrl: await generateJdPromotionUrl(config, credentials, entry.materialUrl, fetchImpl, options),
    ...(positiveNumber(entry.inOrderCount30Days) !== undefined ? { salesCount: positiveNumber(entry.inOrderCount30Days) } : {}),
    ...(positiveNumber(entry.goodCommentsShare) !== undefined ? { rating: positiveNumber(entry.goodCommentsShare) } : {}),
    hasCoupon: Boolean(entry.couponInfo?.couponList?.coupon),
    capturedAt,
    affiliate: true as const,
  })));
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
    type: "pdd.ddk.goods.search",
    client_id: credentials.clientId,
    timestamp: String(Math.floor((options.now ?? new Date()).getTime() / 1000)),
    data_type: "JSON",
    keyword: query.keyword,
    page: "1",
    page_size: "30",
    sort_type: "0",
    with_coupon: "false",
    pid: config.pid,
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
  const goods = (data?.goods_list ?? [])
    .filter((entry) => entry.goods_sign && entry.goods_name && entry.min_group_price > 0)
    .filter((entry) => inPriceRange(readPddCouponPrice(entry), query))
    .map((entry) => ({ entry, score: pddProductScore(entry, query.keyword) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, query.count);
  const capturedAt = (options.now ?? new Date()).toISOString();
  return Promise.all(goods.map(async ({ entry }) => ({
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
    promotionUrl: await generatePddPromotionUrl(
      config,
      credentials,
      entry.goods_sign,
      entry.search_id ?? data?.search_id,
      fetchImpl,
      options,
    ),
    ...(parseSalesCount(entry.sales_tip) !== undefined ? { salesCount: parseSalesCount(entry.sales_tip) } : {}),
    hasCoupon: entry.has_coupon === true,
    capturedAt,
    affiliate: true as const,
  })));
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
    type: "pdd.ddk.goods.promotion.url.generate",
    client_id: credentials.clientId,
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

function jdProductScore(goods: JdGoods, keyword: string): number {
  const relevance = relevanceScore(`${goods.skuName} ${goods.brandName ?? ""}`, keyword);
  if (relevance <= 0) return 0;
  const rating = Math.max(0, Math.min(Number(goods.goodCommentsShare ?? 0) / 100, 1));
  const sales = Math.min(Number(goods.inOrderCount30Days ?? 0) / 10_000, 1);
  const selfOperated = goods.owner === "g" ? 1 : 0;
  const coupon = goods.couponInfo?.couponList?.coupon ? 1 : 0;
  return relevance * 60 + rating * 20 + sales * 10 + selfOperated * 7 + coupon * 3;
}

function pddProductScore(goods: PddGoods, keyword: string): number {
  const relevance = relevanceScore(`${goods.goods_name} ${goods.brand_name ?? ""}`, keyword);
  if (relevance <= 0) return 0;
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

function readJdPrice(goods: JdGoods): number {
  return finitePrice(goods.priceInfo?.lowestCouponPrice)
    ?? finitePrice(goods.priceInfo?.lowestPrice)
    ?? finitePrice(goods.priceInfo?.price)
    ?? 0;
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
