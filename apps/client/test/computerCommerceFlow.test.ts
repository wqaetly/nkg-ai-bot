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
  PUBLIC_MARKET_SEARCH_ENV_KEYS,
  createAffiliateCommerceNode,
  createComputerPromotionResolverNode,
  createPublicMarketSearchNode,
} from "@nkg-ai-bot/commerce-flow";
import { createComputerAdvisorNodes } from "@nkg-ai-bot/commerce-flow/computer-advisor";
import { createComputerAdvisorV4Nodes } from "@nkg-ai-bot/commerce-flow/computer-advisor-v4";
import {
  COMPUTER_CONFIG_FLOW,
  COMPUTER_CONFIG_FLOW_ID,
  COMPUTER_CONFIG_FLOW_VERSION,
} from "../src/builtinFlows";

const FULL_TOWER_LABELS = ["处理器", "散热器", "主板", "内存", "显卡", "存储", "电源", "机箱"];
const USER_VERIFICATION_PHRASES = [
  "请自行核验",
  "请自行确认",
  "用户自行核验",
  "需要你核验",
  "需要用户核验",
  "请确认商品信息",
];

describe("computer commerce Flow V4", () => {
  it("returns a deterministic eight-slot report without commerce when a full build has no budget", async () => {
    const prompts: string[] = [];
    const request = vi.fn(async () => jsonResponse({}));
    const llmProvider = createTaskAwareLlm(prompts, {
      requirement: fullBuildRequirement(),
      blueprint: emptyBlueprint("diy_full"),
    });
    const runtime = await createComputerFlowRuntime(llmProvider, request);

    const result = await invokeComputerFlow(runtime, "帮我配一套适合 2K 游戏的台式电脑，不需要显示器和键鼠", false);

    expect(result.error).toBeUndefined();
    expect(result.succeeded).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("电脑购买需求规格化器");
    expect(prompts[1]).toContain("电脑技术蓝图规划器");
    expect(request).not.toHaveBeenCalled();
    expectCompleteTowerReport(result.output);
    expect(result.output).toContain("本轮联盟推广商品核验覆盖：0/8");
    expect(result.output).toContain("技术蓝图仍完整保留");
    expect(result.output).toContain("本轮按需求策略不调用实时商品服务");
    expect(result.output).not.toContain("用户总预算");
  });

  it("bounds zero-result commerce and still reports every full-build slot", async () => {
    const prompts: string[] = [];
    const request = vi.fn(async () => jsonResponse({
      goods_search_response: { search_id: "empty-search", goods_list: [] },
    }));
    const llmProvider = createTaskAwareLlm(prompts, {
      requirement: fullBuildRequirement(8_000),
      blueprint: emptyBlueprint("diy_full"),
    });
    const runtime = await createComputerFlowRuntime(llmProvider, request);

    const result = await invokeComputerFlow(runtime, "预算 8000 元，帮我配一整套 2K 游戏主机", true);

    expect(result.error).toBeUndefined();
    expect(result.succeeded).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts.every((prompt) =>
      prompt.includes("电脑购买需求规格化器") || prompt.includes("电脑技术蓝图规划器"),
    )).toBe(true);
    const methods = requestedPddMethods(request);
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.length).toBeLessThanOrEqual(40);
    expect(methods.every((method) => method === "pdd.ddk.oauth.goods.search")).toBe(true);
    expect(methods).not.toContain("pdd.ddk.oauth.goods.prom.url.generate");
    expectCompleteTowerReport(result.output);
    expect(result.output).toContain("本轮联盟推广商品核验覆盖：0/8");
    expect(result.output).toContain("未生成任何商品链接");
    expect(result.output).toContain("未命中槽位已完成市场泛搜");
    expect(result.output).toContain("当前缺口来自推广商品池，不转交用户核价");
  });

  it("keeps public market price ranges when the affiliate pool returns no products", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "search.example.test") {
        const query = url.searchParams.get("q") ?? "";
        return jsonResponse({ results: [{
          title: `${query} 公开报价 ¥999`,
          content: "当前售价 999 元",
          url: `https://prices.example.test/${encodeURIComponent(query)}`,
        }] });
      }
      return jsonResponse({ goods_search_response: { goods_list: [] } });
    });
    const runtime = await createComputerFlowRuntime(createTaskAwareLlm([], {
      requirement: fullBuildRequirement(8_000),
      blueprint: emptyBlueprint("diy_full"),
    }), request);

    const result = await invokeComputerFlow(runtime, "预算 8000 元，只要主机，2K 游戏", true, true);

    expect(result.succeeded).toBe(true);
    expect(result.output).toContain("公开市场参考价覆盖：8/8");
    expect(result.output).toContain("公开市场逐槽参考合计：¥7,992–¥7,992");
    expect(result.output).toContain("联盟推广商品池未命中");
    expect(result.output).toContain("[来源1](https://prices.example.test/");
  });

  it("searches the exact technical model and resolves a link only for the selected product", async () => {
    const prompts: string[] = [];
    const request = vi.fn(async (input: string | URL | Request) => {
      const method = new URL(String(input)).searchParams.get("type");
      if (method === "pdd.ddk.oauth.goods.search") {
        return jsonResponse({
          goods_search_response: {
            search_id: "gpu-search",
            goods_list: [{
              goods_name: "七彩虹 RTX 4060 8GB 游戏显卡",
              goods_sign: "gpu-selected",
              min_group_price: 299_900,
              has_coupon: false,
              mall_name: "品牌旗舰店",
              merchant_type: 3,
            }],
          },
        });
      }
      if (method === "pdd.ddk.oauth.goods.prom.url.generate") {
        return jsonResponse({
          goods_promotion_url_generate_response: {
            goods_promotion_url_list: [{ short_url: "https://p.pinduoduo.com/v4-selected" }],
          },
        });
      }
      return new Response("unexpected affiliate method", { status: 500 });
    });
    const llmProvider = createTaskAwareLlm(prompts, {
      requirement: singleGpuRequirement(3_500),
      blueprint: singleGpuBlueprint(),
    });
    const runtime = await createComputerFlowRuntime(llmProvider, request);

    const result = await invokeComputerFlow(runtime, "预算 3500 元，只推荐一张适合 2K 游戏的 RTX 4060 显卡", true);

    expect(result.error).toBeUndefined();
    expect(result.succeeded).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(requestedPddMethods(request)).toEqual([
      "pdd.ddk.oauth.goods.search",
      "pdd.ddk.oauth.goods.prom.url.generate",
    ]);
    const exactModelUrl = new URL(String(request.mock.calls[0]?.[0]));
    expect(exactModelUrl.searchParams.has("range_list")).toBe(false);
    expect(exactModelUrl.searchParams.get("keyword")?.toLowerCase()).toContain("rtx 4060");
    expect(exactModelUrl.searchParams.get("keyword")).not.toBe("独立显卡");
    const promotionUrl = new URL(String(request.mock.calls[1]?.[0]));
    expect(promotionUrl.searchParams.get("search_id")).toBe("gpu-search");
    expect(result.output).toContain("七彩虹 RTX 4060 8GB 游戏显卡");
    expect(result.output).toContain("¥2,999");
    expect(result.output).toContain("[推广链接](https://p.pinduoduo.com/v4-selected)");
    expect(result.output.match(/<!-- v4-slot:/g)).toHaveLength(1);
    expectNoUserVerification(result.output);
  });

  it.each([
    { failedTask: "requirement" as const, title: "requirement planner" },
    { failedTask: "blueprint" as const, title: "blueprint planner" },
  ])("routes a failed $title through deterministic fallback ports", async ({ failedTask }) => {
    const prompts: string[] = [];
    const request = vi.fn(async () => jsonResponse({}));
    const llmProvider = createTaskAwareLlm(prompts, {
      requirement: fullBuildRequirement(),
      blueprint: emptyBlueprint("diy_full"),
      fail: failedTask,
    });
    const runtime = await createComputerFlowRuntime(llmProvider, request);

    const result = await invokeComputerFlow(runtime, "帮我配一套 2K 游戏主机，先给完整方案", false);

    expect(result.error).toBeUndefined();
    expect(result.succeeded).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("电脑购买需求规格化器"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("电脑技术蓝图规划器"))).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expectCompleteTowerReport(result.output);
    expect(result.output).not.toContain("用户总预算");
    if (failedTask === "blueprint") {
      expect(result.output).toContain("AMD Ryzen 5 7500F");
    }
  });
});

function createTaskAwareLlm(
  prompts: string[],
  responses: {
    requirement: unknown;
    blueprint: unknown;
    fail?: "requirement" | "blueprint";
  },
): LlmProvider {
  return {
    async complete(completion) {
      prompts.push(completion.prompt);
      if (completion.prompt.includes("电脑购买需求规格化器")) {
        if (responses.fail === "requirement") throw new Error("requirement planner unavailable");
        return { text: JSON.stringify(responses.requirement) };
      }
      if (completion.prompt.includes("电脑技术蓝图规划器")) {
        if (responses.fail === "blueprint") throw new Error("blueprint planner unavailable");
        return { text: JSON.stringify(responses.blueprint) };
      }
      throw new Error(`unexpected unrestricted LLM task: ${completion.prompt.slice(0, 120)}`);
    },
  };
}

async function createComputerFlowRuntime(
  llmProvider: LlmProvider,
  request: typeof globalThis.fetch,
) {
  const runtime = createPortableRuntime({
    llmProvider,
    fetch: request,
    nodes: [
      createAffiliateCommerceNode(request),
      createComputerPromotionResolverNode(request),
      createPublicMarketSearchNode(request),
      ...createComputerAdvisorNodes(),
      ...createComputerAdvisorV4Nodes(),
    ],
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
  return runtime;
}

async function invokeComputerFlow(
  runtime: Awaited<ReturnType<typeof createComputerFlowRuntime>>,
  input: string,
  commerceEnabled: boolean,
  marketSearchEnabled = false,
) {
  return runtime.invocationRouter.invoke({
    flowId: COMPUTER_CONFIG_FLOW_ID,
    flowVersion: COMPUTER_CONFIG_FLOW_VERSION,
    input,
    variables: new InMemoryVariableStore([
      { name: "LLM_BASE_URL", value: "https://model.example.test/v1" },
      { name: "LLM_DEFAULT_MODEL", value: "test-model" },
      { name: AFFILIATE_ENV_KEYS.enabled, value: commerceEnabled },
      { name: AFFILIATE_ENV_KEYS.pddPid, value: "100_200" },
      { name: PUBLIC_MARKET_SEARCH_ENV_KEYS.enabled, value: marketSearchEnabled },
      { name: PUBLIC_MARKET_SEARCH_ENV_KEYS.mode, value: "searxng" },
      { name: PUBLIC_MARKET_SEARCH_ENV_KEYS.baseUrl, value: "https://search.example.test" },
    ]),
    secrets: new InMemoryVariableStore([
      { name: "LLM_API_KEY", value: "model-secret" },
      { name: AFFILIATE_ENV_KEYS.pddClientId, value: "pdd-client" },
      { name: AFFILIATE_ENV_KEYS.pddClientSecret, value: "pdd-secret" },
      { name: AFFILIATE_ENV_KEYS.pddAccessToken, value: "pdd-access-token" },
    ]),
  });
}

function fullBuildRequirement(budgetAmount?: number) {
  return {
    status: "ready",
    intent: "diy_full",
    deviceType: "desktop",
    targetParts: [],
    ownedParts: [],
    excludedParts: [],
    useCases: ["2K 游戏"],
    workloadProfile: "gaming",
    region: "中国大陆",
    budget: {
      mode: budgetAmount === undefined ? "unknown" : "hard",
      ...(budgetAmount === undefined ? {} : { amount: budgetAmount }),
      currency: "CNY",
      hardCap: budgetAmount !== undefined,
      scope: "tower",
    },
    assumptions: [],
  };
}

function singleGpuRequirement(budgetAmount: number) {
  return {
    status: "ready",
    intent: "parts",
    deviceType: "desktop",
    targetParts: ["gpu"],
    ownedParts: [],
    excludedParts: [],
    useCases: ["2K 游戏"],
    workloadProfile: "gaming",
    region: "中国大陆",
    budget: {
      mode: "hard",
      amount: budgetAmount,
      currency: "CNY",
      hardCap: true,
      scope: "target_parts",
    },
    assumptions: [],
  };
}

function emptyBlueprint(route: "diy_full" | "parts") {
  return {
    schemaVersion: "computer.blueprint.v4",
    route,
    slots: [],
    assumptions: [],
    notes: [],
  };
}

function singleGpuBlueprint() {
  return {
    schemaVersion: "computer.blueprint.v4",
    route: "parts",
    slots: [{
      slotId: "slot-gpu",
      partType: "gpu",
      required: true,
      primaryModel: "七彩虹 RTX 4060 8GB",
      alternatives: [
        { model: "七彩虹 RTX 3060 12GB", direction: "lower_cost" },
        { model: "七彩虹 RTX 4070 12GB", direction: "higher_performance" },
      ],
      requiredSpecs: { vramGB: 8, recommendedPsuW: 550 },
      reason: "满足 2K 游戏目标",
      utilityWeight: 100,
      performanceTier: "balanced",
    }],
    assumptions: [],
    notes: [],
  };
}

function expectCompleteTowerReport(output: unknown) {
  expect(typeof output).toBe("string");
  const markdown = String(output);
  expect(markdown).toContain("## 完整配置表");
  expect(markdown.match(/<!-- v4-slot:/g)).toHaveLength(8);
  for (const label of FULL_TOWER_LABELS) {
    expect(markdown).toContain(`| ${label} |`);
  }
  expectNoUserVerification(markdown);
}

function expectNoUserVerification(markdown: string) {
  for (const phrase of USER_VERIFICATION_PHRASES) expect(markdown).not.toContain(phrase);
}

function requestedPddMethods(request: ReturnType<typeof vi.fn>): Array<string | null> {
  return request.mock.calls.map((call) => new URL(String(call[0])).searchParams.get("type"));
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
