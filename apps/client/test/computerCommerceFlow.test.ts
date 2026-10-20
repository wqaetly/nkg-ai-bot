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
  createComputerRevisionNodes,
  createBrowserCommerceNode,
  createComputerProductLinksNode,
  BROWSER_COMMERCE_ENDPOINT,
  SHOPPING_PLATFORM_VARIABLE,
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
    expect(result.output).toContain("已核价 0/8 项");
    expect(result.output).toContain("表中保留计划型号");
    expect(result.output).toContain("总价：暂无法计算");
    expect(result.output).not.toContain("用户总预算");
  });

  it("bounds zero-result commerce and still reports every full-build slot", async () => {
    const prompts: string[] = [];
    const request = vi.fn(async () => jsonResponse({ status: "empty", products: [] }));
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
    expect(request.mock.calls.length).toBeGreaterThan(0);
    expect(request.mock.calls.length).toBeLessThanOrEqual(24);
    expectCompleteTowerReport(result.output);
    expect(result.output).toContain("已核价 0/8 项");
    expect(result.output).toContain("商品核价未完成");
    expect(result.output).toContain("总价：暂无法计算");
    expect(result.output).toContain("## 总结与建议");
  });

  it("uses fresh search for replacement planning but never treats snippet prices as quotes", async () => {
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
      return jsonResponse({ status: "empty", products: [] });
    });
    const runtime = await createComputerFlowRuntime(createTaskAwareLlm([], {
      requirement: fullBuildRequirement(8_000),
      blueprint: emptyBlueprint("diy_full"),
    }), request);

    const result = await invokeComputerFlow(runtime, "预算 8000 元，只要主机，2K 游戏", true, true);

    expect(result.succeeded).toBe(true);
    expect(request.mock.calls.some((call) => String(call[0]).startsWith("https://search.example.test"))).toBe(true);
    expect(result.output).not.toContain("¥999");
    expect(result.output).not.toContain("公开市场");
    expect(result.output).toContain("总价：暂无法计算");
  });

  it.each([
    ["pdd", "https://mobile.yangkeduo.com/goods.html?goods_id=123"],
    ["jd", "https://item.jd.com/123.html"],
    ["taobao", "https://item.taobao.com/item.htm?id=123"],
  ])("collects %s details and delivers a direct product link without affiliate credentials", async (provider, url) => {
    const calls: Array<Record<string, unknown>> = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(BROWSER_COMMERCE_ENDPOINT);
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      expect(body.provider).toBe(provider);
      return jsonResponse({ status: "ok", products: [{ title: "七彩虹 RTX 4060 8GB 游戏显卡", price: body.url ? 2999 : null, url }] });
    });
    const runtime = await createComputerFlowRuntime(createTaskAwareLlm([], {
      requirement: singleGpuRequirement(3500), blueprint: singleGpuBlueprint(),
    }), request);
    const result = await invokeComputerFlow(runtime, "预算 3500，只推荐 RTX 4060 显卡", false, false, provider);
    expect(result.error).toBeUndefined();
    expect(result.succeeded).toBe(true);
    expect(calls).toHaveLength(2); // Search is disabled: do not silently change models.
    expect(calls[0]?.keyword).toMatch(/4060/);
    expect(calls[1]?.url).toBe(url);
    expect(result.output).toContain("[直达](" + url + ")");
    expect(result.output).toContain("¥2,999");
    expect(result.output).toContain("**总价：¥2,999**");
    expect(result.output).toContain("结算价格以所选规格");
    expect(result.output).not.toContain("推广链接");
  });

  it.each(["login_required", "verification_required", "parser_unmatched"])("stops %s instead of repeatedly searching or losing the blueprint", async (status) => {
    const request = vi.fn(async () => jsonResponse({ status, products: [] }));
    const runtime = await createComputerFlowRuntime(createTaskAwareLlm([], {
      requirement: fullBuildRequirement(8000), blueprint: emptyBlueprint("diy_full"),
    }), request);
    const result = await invokeComputerFlow(runtime, "预算8000配整机", false);
    expect(result.succeeded).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expectCompleteTowerReport(result.output);
    expect(result.output).toContain("商城采集暂不可用");
  });

  it.each([3400, 7000])("rechecks an upgrade at %s and renders the best affordable combination", async (upgradePrice) => {
    const keywords: string[] = [];
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(_input).startsWith("https://search.example.test")) return jsonResponse({ results: [{ title: "RTX 4070 12GB 升级性能", content: "RTX 4070 适合游戏", url: "https://review.example.test/4070" }] });
      const body = JSON.parse(String(init?.body));
      if (body.keyword) keywords.push(body.keyword);
      const upgrade = body.url ? body.url.includes("4070") : body.keyword.includes("4070");
      return jsonResponse({ status: "ok", products: [{ title: upgrade ? "七彩虹 RTX 4070 12GB 显卡" : "七彩虹 RTX 4060 8GB 显卡",
        price: upgrade ? upgradePrice : 2999, url: `https://item.jd.com/${upgrade ? "4070" : "4060"}.html` }] });
    });
    const runtime = await createComputerFlowRuntime(createTaskAwareLlm([], {
      requirement: singleGpuRequirement(3500), blueprint: singleGpuBlueprint(),
      revisions: [{ model: "RTX 4070 12GB", sources: ["https://review.example.test/4070"], reason: "预算内升级" }],
    }), request);
    const result = await invokeComputerFlow(runtime, "预算3500元，给我显卡推荐", false, true, "jd");
    expect(result.succeeded).toBe(true);
    expect(keywords).toEqual(["RTX 4060", "RTX 4070"]);
    expect(result.output).toContain(upgradePrice <= 3500 ? "**总价：¥3,400**" : "**总价：¥2,999**");
    expect(result.output).not.toContain("¥7,000");
    expect(result.output).not.toContain("v4-slot:");
    expect(String(result.output).match(/^## /gm)).toHaveLength(2);
  });

  it("researches new models and reprices two expensive parts until the whole build fits the budget", async () => {
    const sequence: string[] = [];
    const models = [
      { title: "RTX 4070 12GB 显卡", price: 6500, id: "4070" },
      { title: "金百达 银爵 DDR5 6000 32GB 内存", price: 2500, id: "32" },
      { title: "RTX 4060 Ti 16GB 显卡", price: 6000, id: "4060" },
      { title: "光威 天策 DDR5 6000 32GB 内存", price: 1800, id: "33" },
    ];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://search.example.test")) {
        sequence.push("web");
        return jsonResponse({ results: models.slice(2).map((item) => ({ title: item.title, content: "同平台性能与价格比较", url: `https://review.example.test/${item.id}` })) });
      }
      const body = JSON.parse(String(init?.body));
      const item = body.url ? models.find((item) => body.url === `https://item.jd.com/${item.id}.html`)!
        : models.find((item) => body.keyword.includes("4060") ? item.id === "4060" : body.keyword.includes("4070") ? item.id === "4070" : body.keyword.includes("光威") ? item.id === "33" : item.id === "32")!;
      if (body.keyword) sequence.push(item.id);
      return jsonResponse({ status: "ok", products: [{ ...item, url: `https://item.jd.com/${item.id}.html` }] });
    });
    const prompts: string[] = [];
    const runtime = await createComputerFlowRuntime(createTaskAwareLlm(prompts, {
      requirement: { ...singleGpuRequirement(8000), targetParts: ["gpu", "memory"] },
      blueprint: { route: "parts", slots: [
        { partType: "gpu", primaryModel: "RTX 4070 12GB", utilityWeight: 30, requiredSpecs: { vramGB: 12 }, alternatives: [] },
        { partType: "memory", primaryModel: "金百达 银爵 DDR5 6000 32GB", utilityWeight: 12, requiredSpecs: { memoryType: "DDR5", capacityGB: 32 }, alternatives: [] },
      ] },
      revisions: [
        { model: "RTX 4060 Ti 16GB", sources: ["https://review.example.test/4060"], reason: "先降低显卡档位节省500元" },
        { model: "光威 天策 DDR5 6000 32GB", sources: ["https://review.example.test/33"], reason: "保留容量并更换低溢价内存" },
      ],
    }), request);
    const result = await invokeComputerFlow(runtime, "8000元升级显卡和内存，其他部件已有", false, true, "jd");
    expect(result.succeeded).toBe(true);
    expect(sequence).toEqual(["4070", "32", "web", "web", "4060", "web", "web", "33"]);
    expect(prompts.filter((prompt) => prompt.includes("电脑配置替代分析器"))).toHaveLength(2);
    expect(result.output).toContain("**总价：¥7,800**");
    expect(result.output).toContain("光威 天策");
    expect(result.output).not.toContain("RTX 4070");
    expect(result.output).not.toContain("v4-slot:");
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
    revisions?: unknown[];
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
      if (completion.prompt.includes("电脑配置替代分析器")) return { text: JSON.stringify(responses.revisions?.shift() ?? null) };
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
      createBrowserCommerceNode(request),
      createComputerProductLinksNode(),
      createAffiliateCommerceNode(request),
      createComputerPromotionResolverNode(request),
      createPublicMarketSearchNode(request),
      ...createComputerRevisionNodes(request),
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
  shoppingPlatform = "pdd",
) {
  return runtime.invocationRouter.invoke({
    flowId: COMPUTER_CONFIG_FLOW_ID,
    flowVersion: COMPUTER_CONFIG_FLOW_VERSION,
    input,
    variables: new InMemoryVariableStore([
      { name: "LLM_BASE_URL", value: "https://model.example.test/v1" },
      { name: "LLM_DEFAULT_MODEL", value: "test-model" },
      { name: SHOPPING_PLATFORM_VARIABLE, value: shoppingPlatform },
      { name: AFFILIATE_ENV_KEYS.enabled, value: commerceEnabled },
      { name: AFFILIATE_ENV_KEYS.pddPid, value: "100_200" },
      { name: PUBLIC_MARKET_SEARCH_ENV_KEYS.enabled, value: marketSearchEnabled },
      { name: PUBLIC_MARKET_SEARCH_ENV_KEYS.mode, value: "searxng" },
      { name: PUBLIC_MARKET_SEARCH_ENV_KEYS.baseUrl, value: "https://search.example.test" },
    ]),
    secrets: new InMemoryVariableStore([
      { name: "LLM_API_KEY", value: "model-secret" },
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
  expect(markdown).toContain("## 配置清单");
  expect(markdown).not.toContain("<!-- v4-slot:");
  expect(markdown.split("\n").filter((line) => /^\| /.test(line))).toHaveLength(9);
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
