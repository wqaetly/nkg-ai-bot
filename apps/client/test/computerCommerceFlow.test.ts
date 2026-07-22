import { describe, expect, it, vi } from "vitest";
import {
  PORTABLE_CORE_CAPABILITIES,
  createRuntimeCapabilityManifest,
} from "@ai-native-flow/runtime/capabilities";
import {
  createPortableRuntime,
  type LlmProvider,
} from "@ai-native-flow/runtime";
import { InMemoryVariableStore } from "@ai-native-flow/variable-store/browser";
import {
  AFFILIATE_ENV_KEYS,
  createAffiliateCommerceNode,
} from "@nkg-ai-bot/commerce-flow";
import {
  COMPUTER_CONFIG_FLOW,
  COMPUTER_CONFIG_FLOW_ID,
  COMPUTER_CONFIG_FLOW_VERSION,
} from "../src/builtinFlows";

describe("computer commerce Flow", () => {
  it("runs planning, affiliate search and promotion, then the advisor in one graph", async () => {
    const prompts: string[] = [];
    const llmProvider: LlmProvider = {
      async complete(request) {
        prompts.push(request.prompt);
        if (prompts.length === 1) {
          return {
            text: JSON.stringify({
              queries: [{ keyword: "七彩虹 RTX 4060 显卡", count: 1 }],
            }),
          };
        }
        return { text: "已生成带推广披露的电脑配置建议" };
      },
    };
    const request = vi.fn(async () => {
      if (request.mock.calls.length === 1) {
        return jsonResponse({
          goods_search_response: {
            search_id: "search-1",
            goods_list: [{
              goods_name: "七彩虹 RTX 4060 8GB 游戏显卡",
              goods_sign: "gpu-1",
              min_group_price: 299900,
              has_coupon: false,
              mall_name: "品牌旗舰店",
              merchant_type: 3,
            }],
          },
        });
      }
      return jsonResponse({
        goods_promotion_url_generate_response: {
          goods_promotion_url_list: [{ short_url: "https://p.pinduoduo.com/affiliate" }],
        },
      });
    });
    const runtime = createPortableRuntime({
      llmProvider,
      fetch: request,
      nodes: [createAffiliateCommerceNode(request)],
      capabilities: createRuntimeCapabilityManifest({
        platform: "portable",
        available: PORTABLE_CORE_CAPABILITIES,
      }),
    });
    await runtime.registry.register({
      graph: COMPUTER_CONFIG_FLOW,
      json: JSON.stringify(COMPUTER_CONFIG_FLOW),
    });
    await runtime.registry.promote(COMPUTER_CONFIG_FLOW_ID, COMPUTER_CONFIG_FLOW_VERSION);
    const nodeEvents: string[] = [];
    runtime.eventBus.subscribe("*", (event) => {
      if (event.kind === "node_started" || event.kind === "node_finished" || event.kind === "node_error") {
        nodeEvents.push(`${event.kind}:${event.nodeId}`);
      }
    });

    const result = await runtime.invocationRouter.invoke({
      flowId: COMPUTER_CONFIG_FLOW_ID,
      flowVersion: COMPUTER_CONFIG_FLOW_VERSION,
      input: "预算 6000 元，帮我配置一台 2K 游戏电脑",
      variables: new InMemoryVariableStore([
        { name: "LLM_BASE_URL", value: "https://model.example.test/v1" },
        { name: "LLM_DEFAULT_MODEL", value: "test-model" },
        { name: AFFILIATE_ENV_KEYS.enabled, value: true },
        { name: AFFILIATE_ENV_KEYS.provider, value: "pdd" },
        { name: AFFILIATE_ENV_KEYS.pddPid, value: "100_200" },
      ]),
      secrets: new InMemoryVariableStore([
        { name: "LLM_API_KEY", value: "model-secret" },
        { name: AFFILIATE_ENV_KEYS.pddClientId, value: "pdd-client" },
        { name: AFFILIATE_ENV_KEYS.pddClientSecret, value: "pdd-secret" },
      ]),
    });

    expect(result.error).toBeUndefined();
    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("已生成带推广披露的电脑配置建议");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("电脑配置商品查询规划器");
    expect(prompts[0]).toContain("预算 6000 元");
    expect(prompts[1]).toContain("七彩虹 RTX 4060 8GB 游戏显卡");
    expect(prompts[1]).toContain("https://p.pinduoduo.com/affiliate");
    expect(prompts[1]).toContain("不得按佣金排序");
    expect(request).toHaveBeenCalledTimes(2);
    expect(nodeEvents.filter((entry) => entry.startsWith("node_started")))
      .toEqual([
        "node_started:start",
        "node_started:product_query_planner",
        "node_started:parse_query_plan",
        "node_started:affiliate_products",
        "node_started:chat_model",
        "node_started:end",
      ]);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
