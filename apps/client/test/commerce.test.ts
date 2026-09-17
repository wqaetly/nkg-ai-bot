import { describe, expect, it, vi } from "vitest";
import {
  AFFILIATE_ENV_KEYS,
  PUBLIC_MARKET_SEARCH_ENV_KEYS,
  createPublicMarketSearchNode,
  createComputerPromotionResolverNode,
  createPddAccessToken,
  generatePddAuthorizationUrl,
  refreshPddAccessToken,
  isAffiliateProductMatch,
  resolveAffiliateProductPromotion,
  searchAffiliateProducts,
  signParameters,
  type AffiliateCommerceConfig,
} from "@nkg-ai-bot/commerce-flow";

describe("affiliate commerce clients", () => {
  it("builds a cited public-market price range only from matching model results", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/search");
      expect(url.searchParams.get("q")).toContain("AMD Ryzen 5 7500F");
      return jsonResponse({ results: [
        { title: "AMD Ryzen 5 7500F 处理器报价 ¥999", url: "https://shop-a.example/7500f", content: "盒装 CPU 现价 999 元" },
        { title: "AMD Ryzen 5 7500F CPU", url: "https://shop-b.example/7500f", content: "到手价：1099 元" },
        { title: "AMD Ryzen 7 9700X 处理器", url: "https://wrong.example/9700x", content: "售价 2499 元" },
      ] });
    });
    const node = createPublicMarketSearchNode(request);
    const values: Record<string, unknown> = {
      [PUBLIC_MARKET_SEARCH_ENV_KEYS.enabled]: true,
      [PUBLIC_MARKET_SEARCH_ENV_KEYS.mode]: "searxng",
      [PUBLIC_MARKET_SEARCH_ENV_KEYS.baseUrl]: "https://search.example",
      [PUBLIC_MARKET_SEARCH_ENV_KEYS.apiKey]: "search-key",
    };
    const result = await node.runner({
      blueprint: {
        slots: [{
          slotId: "slot-cpu",
          partType: "cpu",
          required: true,
          primaryModel: "AMD Ryzen 5 7500F",
          requiredSpecs: { socket: "AM5" },
        }],
      },
      __config__: { maxSlots: 8, maxResultsPerSlot: 6, concurrency: 2 },
    }, marketSearchContext(values));

    expect(result.kind).toBe("success");
    if (result.kind !== "success") throw new Error("market search should succeed");
    expect(result.outputs.evidence).toEqual([expect.objectContaining({
      slotId: "slot-cpu",
      minPrice: 999,
      medianPrice: 1099,
      maxPrice: 1099,
      confidence: "multi_source",
      samples: [
        expect.objectContaining({ url: "https://shop-a.example/7500f", price: 999 }),
        expect.objectContaining({ url: "https://shop-b.example/7500f", price: 1099 }),
      ],
    })]);
    expect(result.outputs.errors).toEqual([]);
  });

  it("rejects an external USB drive for an NVMe system-drive slot", () => {
    const query = {
      keyword: "致态 TiPlus7100 1TB NVMe 固态硬盘",
      partType: "storage",
      requiredSpecs: { interface: "PCIe 4.0", formFactor: "M.2 2280" },
      stage: "exact_model",
      modelAnchors: ["TiPlus7100"],
    } as const;

    expect(isAffiliateProductMatch("忆捷移动硬盘1TB USB3.0 外置机械硬盘", query)).toBe(false);
    expect(isAffiliateProductMatch("致态 TiPlus7100 1TB NVMe M.2 固态硬盘", query)).toBe(true);
  });

  it("treats spec fallback terms as specifications instead of an exact model identity", () => {
    const query = {
      keyword: "NVMe PCIe M.2 2280 1000 内置固态硬盘",
      partType: "storage",
      stage: "spec_fallback",
      modelAnchors: [],
      negativeTerms: ["移动硬盘", "外置", "USB"],
    } as const;

    expect(isAffiliateProductMatch("三星 SSD M.2 NVMe 内置固态硬盘", query)).toBe(true);
    expect(isAffiliateProductMatch("三星 USB 外置移动硬盘", query)).toBe(false);
  });

  it("filters a Mini-ITX-only case when the plan requires ATX support", () => {
    const query = {
      keyword: "联力 LANCOOL 216 机箱",
      partType: "case",
      requiredSpecs: { supportedMotherboardFormFactors: ["ATX", "mATX", "Mini-ITX"] },
      stage: "market_confirmation",
      modelAnchors: ["lancool216"],
    } as const;

    expect(isAffiliateProductMatch("迷你 MINI 手提 ITX 机箱 17*17 主板 小1U电源", query)).toBe(false);
    expect(isAffiliateProductMatch("联力 LANCOOL 216 ATX 中塔电脑机箱", query)).toBe(true);
  });

  it("matches the platform MD5 signing contract", () => {
    expect(signParameters({
      type: "pdd.ddk.oauth.goods.search",
      client_id: "client",
      timestamp: "1",
    }, "secret")).toBe("1B6D6685852BD8AC3CC8838ED276A9A0");
  });

  it("searches JD goods and converts the selected result to an affiliate link", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body);
      expect(body).not.toContain("jd-secret");
      expect(body).toContain("sign=");
      if (request.mock.calls.length === 1) {
        return jsonResponse({
          jd_union_open_goods_query_responce: {
            queryResult: JSON.stringify({
              code: 200,
              data: [{ goodsResp: {
                skuId: 1001,
                skuName: "华硕 RTX 4060 8GB 游戏显卡",
                materialUrl: "item.jd.com/1001.html",
                owner: "g",
                brandName: "华硕",
                inOrderCount30Days: 5000,
                goodCommentsShare: 98,
                priceInfo: { price: 2799, lowestPrice: 2599, lowestCouponPrice: 2499 },
                shopInfo: { shopName: "京东自营" },
                imageInfo: { whiteImage: "https://img.example.test/jd.png" },
                couponInfo: { couponList: { coupon: [{ discount: 100 }] } },
              } }],
            }),
          },
        });
      }
      return jsonResponse({
        jd_union_open_promotion_common_get_responce: {
          getResult: JSON.stringify({ code: 200, data: { clickURL: "https://u.jd.com/affiliate" } }),
        },
      });
    });
    const config: AffiliateCommerceConfig = {
      enabled: true,
      selectedProvider: "jd",
      jd: {
        appKeyRef: "commerce:jd:app-key",
        secretKeyRef: "commerce:jd:secret-key",
        pid: "1_2_3",
        siteId: "2",
        positionId: "3",
      },
    };

    const products = await searchAffiliateProducts(
      config,
      { provider: "jd", appKey: "jd-key", secretKey: "jd-secret" },
      { keyword: "RTX 4060 显卡", minPrice: 2000, maxPrice: 3000, count: 1 },
      request,
      { now: new Date("2026-07-22T02:00:00.000Z") },
    );

    expect(products).toEqual([expect.objectContaining({
      provider: "jd",
      productId: "1001",
      price: 2799,
      couponPrice: 2499,
      promotionUrl: "https://u.jd.com/affiliate",
      affiliate: true,
    })]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("discovers JD candidates without promotion calls and retains the source URL", async () => {
    const request = vi.fn(async () => jsonResponse({
      jd_union_open_goods_query_responce: {
        queryResult: JSON.stringify({
          code: 200,
          data: [{ goodsResp: {
            skuId: 2001,
            skuName: "七彩虹 RTX 4060 8GB 游戏显卡",
            materialUrl: "https://item.jd.com/2001.html",
            owner: "g",
            priceInfo: { price: 2699 },
          } }],
        }),
      },
    }));
    const config: AffiliateCommerceConfig = {
      enabled: true,
      selectedProvider: "jd",
      jd: {
        appKeyRef: "commerce:jd:app-key",
        secretKeyRef: "commerce:jd:secret-key",
        pid: "1_2_3",
        siteId: "2",
        positionId: "3",
      },
    };

    const products = await searchAffiliateProducts(
      config,
      { provider: "jd", appKey: "jd-key", secretKey: "jd-secret" },
      {
        keyword: "七彩虹 RTX 4060 显卡",
        partType: "gpu",
        stage: "exact_model",
        modelAnchors: ["RTX 4060"],
        count: 1,
      },
      request,
      { resolvePromotion: false, now: new Date("2026-08-11T02:00:00.000Z") },
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(products).toEqual([expect.objectContaining({
      productId: "2001",
      sourceUrl: "https://item.jd.com/2001.html",
    })]);
    expect(products[0]?.promotionUrl).toBeUndefined();
  });

  it("filters unrelated PDD results before generating a promotion link", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.toString()).not.toContain("pdd-secret");
      expect(url.searchParams.get("access_token")).toBe("pdd-access-token");
      expect(url.searchParams.get("sign")).toMatch(/^[A-F0-9]{32}$/);
      if (request.mock.calls.length === 1) {
        return jsonResponse({
          goods_search_response: {
            search_id: "search-1",
            goods_list: [
              {
                goods_name: "隐形牙套保持器",
                goods_sign: "unrelated",
                min_group_price: 6800,
                has_coupon: false,
                merchant_type: 3,
              },
              {
                goods_name: "七彩虹 RTX 4060 8GB 台式机游戏显卡",
                goods_sign: "gpu-1",
                min_group_price: 299900,
                coupon_discount: 20000,
                has_coupon: true,
                sales_tip: "1.2万+",
                mall_name: "品牌旗舰店",
                merchant_type: 3,
                brand_name: "七彩虹",
                serv_txt: "高",
                lgst_txt: "高",
                desc_txt: "高",
              },
            ],
          },
        });
      }
      return jsonResponse({
        goods_promotion_url_generate_response: {
          goods_promotion_url_list: [{ short_url: "https://p.pinduoduo.com/affiliate" }],
        },
      });
    });
    const config: AffiliateCommerceConfig = {
      enabled: true,
      selectedProvider: "pdd",
      pdd: {
        clientIdRef: "commerce:pdd:client-id",
        clientSecretRef: "commerce:pdd:client-secret",
        accessTokenRef: "commerce:pdd:access-token",
        pid: "1_2",
      },
    };

    const products = await searchAffiliateProducts(
      config,
      { provider: "pdd", clientId: "pdd-client", clientSecret: "pdd-secret", accessToken: "pdd-access-token" },
      { keyword: "RTX 4060 显卡", count: 1 },
      request,
      { now: new Date("2026-07-22T02:00:00.000Z") },
    );

    expect(products).toEqual([expect.objectContaining({
      provider: "pdd",
      productId: "gpu-1",
      price: 2999,
      couponPrice: 2799,
      promotionUrl: "https://p.pinduoduo.com/affiliate",
      salesCount: 12000,
    })]);
    expect(products[0]?.name).not.toContain("牙套");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("exchanges a PDD authorization code for the initial token pair", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("type")).toBe("pdd.pop.auth.token.create");
      expect(url.searchParams.get("code")).toBe("one-time-code");
      expect(url.searchParams.get("access_token")).toBeNull();
      expect(url.searchParams.get("sign")).toMatch(/^[A-F0-9]{32}$/);
      return jsonResponse({
        pop_auth_token_create_response: {
          access_token: "created-access",
          expires_at: Date.parse("2026-08-11T00:00:00.000Z") / 1000,
          refresh_token: "created-refresh",
          refresh_token_expires_at: Date.parse("2026-08-12T00:00:00.000Z") / 1000,
        },
      });
    });

    await expect(createPddAccessToken(
      "pdd-client",
      "pdd-secret",
      "one-time-code",
      request,
      { now: new Date("2026-08-10T00:00:00.000Z") },
    )).resolves.toEqual({
      accessToken: "created-access",
      accessTokenExpiresAt: "2026-08-11T00:00:00.000Z",
      refreshToken: "created-refresh",
      refreshTokenExpiresAt: "2026-08-12T00:00:00.000Z",
    });
  });

  it("refreshes PDD OAuth tokens and generates a channel_type=10 filing URL", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("sign")).toMatch(/^[A-F0-9]{32}$/);
      if (url.searchParams.get("type") === "pdd.pop.auth.token.refresh") {
        expect(url.searchParams.get("grant_type")).toBeNull();
        return jsonResponse({
          pop_auth_token_refresh_response: {
            access_token: "next-access",
            expires_in: 3600,
            refresh_token: "next-refresh",
            refresh_token_expires_in: 7200,
          },
        });
      }
      expect(url.searchParams.get("type")).toBe("pdd.ddk.oauth.rp.prom.url.generate");
      expect(url.searchParams.get("channel_type")).toBe("10");
      expect(url.searchParams.get("access_token")).toBe("next-access");
      return jsonResponse({
        rp_promotion_url_generate_response: {
          url_list: [{ short_url: "https://p.pinduoduo.com/filing" }],
        },
      });
    });
    const now = new Date("2026-08-10T00:00:00.000Z");
    const refreshed = await refreshPddAccessToken(
      "pdd-client",
      "pdd-secret",
      "old-refresh",
      request,
      { now },
    );
    expect(refreshed).toMatchObject({
      accessToken: "next-access",
      accessTokenExpiresAt: "2026-08-10T01:00:00.000Z",
      refreshToken: "next-refresh",
      refreshTokenExpiresAt: "2026-08-10T02:00:00.000Z",
    });
    await expect(generatePddAuthorizationUrl({
      clientIdRef: "client",
      clientSecretRef: "secret",
      accessTokenRef: "access",
      pid: "1_2",
    }, {
      provider: "pdd",
      clientId: "pdd-client",
      clientSecret: "pdd-secret",
      accessToken: refreshed.accessToken,
    }, request, { now })).resolves.toBe("https://p.pinduoduo.com/filing");
  });

  it("uses the compliance-gated new-customer marker only when explicitly requested", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (request.mock.calls.length === 1) {
        expect(url.searchParams.get("type")).toBe("pdd.ddk.goods.search");
        expect(url.searchParams.get("access_token")).toBeNull();
        expect(url.searchParams.get("custom_parameters")).toBe('{"new":1}');
        return jsonResponse({ goods_search_response: { goods_list: [{
          goods_name: "RTX 4060 游戏显卡",
          goods_sign: "new-gpu",
          min_group_price: 299900,
          has_coupon: false,
        }] } });
      }
      expect(url.searchParams.get("type")).toBe("pdd.ddk.goods.promotion.url.generate");
      return jsonResponse({ goods_promotion_url_generate_response: {
        goods_promotion_url_list: [{ short_url: "https://p.pinduoduo.com/new-user" }],
      } });
    });
    const config: AffiliateCommerceConfig = {
      enabled: true,
      selectedProvider: "pdd",
      pdd: {
        clientIdRef: "client",
        clientSecretRef: "secret",
        accessTokenRef: "access",
        pid: "1_2",
      },
    };

    const products = await searchAffiliateProducts(config, {
      provider: "pdd",
      clientId: "pdd-client",
      clientSecret: "pdd-secret",
      accessToken: "unused-for-new-user",
    }, { keyword: "RTX 4060", count: 1 }, request, { pddNewCustomer: true });

    expect(products[0]?.promotionUrl).toBe("https://p.pinduoduo.com/new-user");
  });

  it("reports raw, structural, price, category and model discovery telemetry", async () => {
    const telemetry: unknown[] = [];
    const request = vi.fn(async () => jsonResponse({
      goods_search_response: {
        search_id: "telemetry-search",
        goods_list: [
          {
            goods_name: "无商品标识的 RTX 4060 显卡",
            goods_sign: "",
            min_group_price: 299900,
            has_coupon: false,
          },
          {
            goods_name: "七彩虹 RTX 4060 8GB 游戏显卡",
            goods_sign: "over-price",
            min_group_price: 499900,
            has_coupon: false,
          },
          {
            goods_name: "RTX 4060 显卡支架",
            goods_sign: "wrong-category",
            min_group_price: 299900,
            has_coupon: false,
          },
          {
            goods_name: "七彩虹 RTX 4070 12GB 游戏显卡",
            goods_sign: "wrong-model",
            min_group_price: 329900,
            has_coupon: false,
          },
          {
            goods_name: "七彩虹 RTX 4060 8GB 游戏显卡",
            goods_sign: "accepted-gpu",
            min_group_price: 299900,
            has_coupon: false,
          },
        ],
      },
    }));
    const config: AffiliateCommerceConfig = {
      enabled: true,
      selectedProvider: "pdd",
      pdd: {
        clientIdRef: "commerce:pdd:client-id",
        clientSecretRef: "commerce:pdd:client-secret",
        accessTokenRef: "commerce:pdd:access-token",
        pid: "1_2",
      },
    };

    const products = await searchAffiliateProducts(
      config,
      {
        provider: "pdd",
        clientId: "pdd-client",
        clientSecret: "pdd-secret",
        accessToken: "pdd-access-token",
      },
      {
        queryId: "gpu-exact-1",
        slotId: "gpu",
        partType: "gpu",
        keyword: "七彩虹 RTX 4060 显卡",
        stage: "exact_model",
        modelAnchors: ["RTX 4060"],
        minPrice: 2500,
        maxPrice: 3500,
        count: 5,
      },
      request,
      {
        resolvePromotion: false,
        now: new Date("2026-08-11T02:00:00.000Z"),
        onTelemetry: (entry) => telemetry.push(entry),
      },
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(products).toEqual([expect.objectContaining({
      productId: "accepted-gpu",
      searchId: "telemetry-search",
    })]);
    expect(products[0]?.promotionUrl).toBeUndefined();
    expect(telemetry).toEqual([{
      queryId: "gpu-exact-1",
      slotId: "gpu",
      partType: "gpu",
      stage: "exact_model",
      keyword: "七彩虹 RTX 4060 显卡",
      provider: "pdd",
      providerRawCount: 5,
      structurallyValidCount: 4,
      rejectedByCategory: 1,
      rejectedByModel: 1,
      rejectedByPrice: 1,
      acceptedCount: 1,
    }]);
  });

  it("resolves one shortlisted PDD product with exactly one promotion call", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("type")).toBe("pdd.ddk.oauth.goods.prom.url.generate");
      expect(url.searchParams.get("goods_sign_list")).toBe('["gpu-one"]');
      expect(url.searchParams.get("search_id")).toBe("search-one");
      return jsonResponse({
        goods_promotion_url_generate_response: {
          goods_promotion_url_list: [{ short_url: "https://p.pinduoduo.com/gpu-one" }],
        },
      });
    });
    const config: AffiliateCommerceConfig = {
      enabled: true,
      selectedProvider: "pdd",
      pdd: {
        clientIdRef: "commerce:pdd:client-id",
        clientSecretRef: "commerce:pdd:client-secret",
        accessTokenRef: "commerce:pdd:access-token",
        pid: "1_2",
      },
    };

    const promotionUrl = await resolveAffiliateProductPromotion(
      config,
      {
        provider: "pdd",
        clientId: "pdd-client",
        clientSecret: "pdd-secret",
        accessToken: "pdd-access-token",
      },
      {
        provider: "pdd",
        productId: "gpu-one",
        name: "七彩虹 RTX 4060 游戏显卡",
        price: 2999,
        searchId: "search-one",
        hasCoupon: false,
        capturedAt: "2026-08-11T02:00:00.000Z",
        affiliate: true,
      },
      request,
      { now: new Date("2026-08-11T02:00:00.000Z") },
    );

    expect(promotionUrl).toBe("https://p.pinduoduo.com/gpu-one");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps other resolver candidates when one promotion call fails", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const signs = JSON.parse(url.searchParams.get("goods_sign_list") ?? "[]") as string[];
      if (signs[0] === "bad-gpu") return new Response("upstream failure", { status: 502 });
      return jsonResponse({
        goods_promotion_url_generate_response: {
          goods_promotion_url_list: [{ short_url: "https://p.pinduoduo.com/good-gpu" }],
        },
      });
    });
    const node = createComputerPromotionResolverNode(request);
    const values: Record<string, unknown> = {
      [AFFILIATE_ENV_KEYS.enabled]: true,
      [AFFILIATE_ENV_KEYS.provider]: "pdd",
      [AFFILIATE_ENV_KEYS.pddClientId]: "pdd-client",
      [AFFILIATE_ENV_KEYS.pddClientSecret]: "pdd-secret",
      [AFFILIATE_ENV_KEYS.pddAccessToken]: "pdd-access-token",
      [AFFILIATE_ENV_KEYS.pddPid]: "1_2",
    };
    const result = await node.runner({
      products: [
        {
          provider: "pdd",
          productId: "bad-gpu",
          name: "失败候选 RTX 4060",
          price: 2899,
          searchId: "search-bad",
          slotId: "gpu-bad",
          hasCoupon: false,
          capturedAt: "2026-08-11T02:00:00.000Z",
          affiliate: true,
        },
        {
          provider: "pdd",
          productId: "good-gpu",
          name: "成功候选 RTX 4060",
          price: 2999,
          searchId: "search-good",
          slotId: "gpu-good",
          hasCoupon: false,
          capturedAt: "2026-08-11T02:00:00.000Z",
          affiliate: true,
        },
      ],
      __config__: { concurrency: 2, retries: 0 },
    }, resolverContext(values));

    expect(result.kind).toBe("success");
    if (result.kind !== "success") throw new Error("resolver should succeed with partial results");
    expect(result.outputs.products).toEqual([expect.objectContaining({
      productId: "good-gpu",
      promotionUrl: "https://p.pinduoduo.com/good-gpu",
    })]);
    expect(result.outputs.errors).toEqual([expect.objectContaining({
      productId: "bad-gpu",
      slotId: "gpu-bad",
      attempts: 1,
    })]);
    expect(result.outputs.summary).toEqual({ requested: 2, linked: 1, failed: 1 });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function resolverContext(
  values: Record<string, unknown>,
): Parameters<ReturnType<typeof createComputerPromotionResolverNode>["runner"]>[1] {
  const get = (name: string) => values[name];
  return {
    runId: "resolver-test-run",
    flowId: "resolver-test-flow",
    flowVersion: "1.0.0",
    nodeId: "resolver",
    nodeType: "computer_promotion_resolver",
    nodeVersion: "1.0.0",
    attempt: 1,
    signal: new AbortController().signal,
    variables: {
      get,
      getString: (name) => typeof get(name) === "string" ? get(name) as string : undefined,
      getNumber: (name) => typeof get(name) === "number" ? get(name) as number : undefined,
      getBoolean: (name) => typeof get(name) === "boolean" ? get(name) as boolean : undefined,
    },
    secrets: { get: () => undefined },
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    triggerEvent: async () => undefined,
    emit: async () => undefined,
    stream: async () => undefined,
  };
}

function marketSearchContext(
  values: Record<string, unknown>,
): Parameters<ReturnType<typeof createPublicMarketSearchNode>["runner"]>[1] {
  const get = (name: string) => values[name];
  return {
    runId: "market-search-test-run",
    flowId: "market-search-test-flow",
    flowVersion: "1.0.0",
    nodeId: "market-search",
    nodeType: "public_market_search",
    nodeVersion: "1.0.0",
    attempt: 1,
    signal: new AbortController().signal,
    variables: {
      get,
      getString: (name) => typeof get(name) === "string" ? get(name) as string : undefined,
      getNumber: (name) => typeof get(name) === "number" ? get(name) as number : undefined,
      getBoolean: (name) => typeof get(name) === "boolean" ? get(name) as boolean : undefined,
    },
    secrets: { get: () => undefined },
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    triggerEvent: async () => undefined,
    emit: async () => undefined,
    stream: async () => undefined,
  };
}
