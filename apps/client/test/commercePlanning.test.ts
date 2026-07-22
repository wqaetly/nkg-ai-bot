import type { NodeEvent } from "@nkg-ai-bot/runtime-router";
import { describe, expect, it, vi } from "vitest";
import {
  collectAffiliateRecommendations,
  parseProductQueryPlan,
} from "../src/commercePlanning";
import { COMPUTER_PRODUCT_PLANNER_FLOW_ID } from "../src/builtinFlows";
import type { LocalMessage } from "../src/storage/repositories";

describe("affiliate product query planning", () => {
  it("bounds, validates, and deduplicates model-produced queries", () => {
    expect(parseProductQueryPlan(`\`\`\`json
      {"queries":[
        {"keyword":"RTX 5070 显卡","minPrice":3000,"maxPrice":5000,"count":9},
        {"keyword":"rtx 5070 显卡","count":1},
        {"keyword":"","count":1},
        {"keyword":"主板","minPrice":2000,"maxPrice":1000}
      ]}
    \`\`\``)).toEqual([{
      keyword: "RTX 5070 显卡",
      minPrice: 3000,
      maxPrice: 5000,
      count: 2,
    }]);
  });

  it("runs the hidden planner Flow and collects affiliate products", async () => {
    const runtime = {
      stream: vi.fn(async function* () {
        yield event("run_finished", {
          output: JSON.stringify({ queries: [{ keyword: "Ryzen 7 9700X 处理器", count: 1 }] }),
        });
      }),
    };
    const commerce = {
      isAffiliateCommerceEnabled: () => true,
      searchAffiliateProducts: vi.fn(async () => [{
        provider: "jd" as const,
        productId: "cpu-1",
        name: "AMD Ryzen 7 9700X",
        price: 2299,
        promotionUrl: "https://u.jd.com/cpu",
        hasCoupon: false,
        capturedAt: "2026-07-22T02:00:00.000Z",
        affiliate: true as const,
      }]),
    };

    const result = await collectAffiliateRecommendations(
      runtime,
      commerce,
      [message("帮我配一台 8000 元的游戏主机")],
    );

    expect(runtime.stream).toHaveBeenCalledWith(
      COMPUTER_PRODUCT_PLANNER_FLOW_ID,
      expect.stringContaining("8000 元"),
      expect.any(Object),
    );
    expect(commerce.searchAffiliateProducts).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: "Ryzen 7 9700X 处理器" }),
      {},
    );
    expect(result.products[0]?.promotionUrl).toBe("https://u.jd.com/cpu");
  });
});

function message(content: string): LocalMessage {
  return {
    id: "m1",
    conversationId: "c1",
    sequence: 1,
    role: "user",
    content,
    createdAt: 1,
  };
}

function event(kind: string, payload: unknown): NodeEvent {
  return {
    eventId: crypto.randomUUID(),
    runId: "planner-run",
    flowId: COMPUTER_PRODUCT_PLANNER_FLOW_ID,
    flowVersion: "1.0.0",
    seq: 1,
    timestamp: new Date(0).toISOString(),
    kind,
    payload,
  };
}
