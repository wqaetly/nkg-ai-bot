import { describe, expect, it, vi } from "vitest";
import {
  searchAffiliateProducts,
  signParameters,
  type AffiliateCommerceConfig,
} from "@nkg-ai-bot/commerce-flow";

describe("affiliate commerce clients", () => {
  it("matches the platform MD5 signing contract", () => {
    expect(signParameters({
      type: "pdd.ddk.goods.search",
      client_id: "client",
      timestamp: "1",
    }, "secret")).toBe("42224C96D69362F6AA357ED081E54373");
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
      price: 2499,
      couponPrice: 2499,
      promotionUrl: "https://u.jd.com/affiliate",
      affiliate: true,
    })]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("filters unrelated PDD results before generating a promotion link", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.toString()).not.toContain("pdd-secret");
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
        pid: "1_2",
      },
    };

    const products = await searchAffiliateProducts(
      config,
      { provider: "pdd", clientId: "pdd-client", clientSecret: "pdd-secret" },
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
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
