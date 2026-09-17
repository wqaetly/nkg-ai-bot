import { describe, expect, it } from "vitest";
import {
  type AffiliateProduct,
  type AffiliateProductQuery,
} from "../src/index";
import {
  normalizeComputerRequirementDraft,
  normalizeComputerTechnicalPlan,
  optimizeComputerRecommendation,
  validateCompatibility,
} from "../src/computerAdvisor";

describe("computer advisor policies", () => {
  it("creates a complete bounded ledger for a full DIY tower", () => {
    const result = normalizeComputerRequirementDraft({
      status: "ready",
      intent: "diy_full",
      deviceType: "desktop",
      requiresProductSearch: true,
      targetParts: [],
      useCases: ["2K 游戏"],
      workloadProfile: "gaming",
      region: "中国大陆",
      budget: { mode: "hard", amount: 6000, currency: "CNY", hardCap: true, scope: "tower" },
      missingFields: [],
    }, "预算 6000 元，只含主机，玩 2K 游戏");

    expect(result.needsPlan).toBe(true);
    expect(result.requirements.targetParts).toEqual([
      "cpu", "cooler", "motherboard", "memory", "gpu", "storage", "psu", "case",
    ]);
    expect(result.budget?.reserveAmount).toBe(300);
    expect(result.budget?.slots.reduce((sum, slot) => sum + slot.targetPrice, 0)).toBe(5700);
    expect(result.budget?.slots.find((slot) => slot.partType === "gpu")?.weight)
      .toBeGreaterThan(result.budget?.slots.find((slot) => slot.partType === "cpu")?.weight ?? 1);
  });

  it("keeps a CPU and motherboard request scoped to those two parts", () => {
    const result = normalizeComputerRequirementDraft({
      status: "ready",
      intent: "parts",
      deviceType: "desktop",
      requiresProductSearch: true,
      targetParts: ["CPU", "主板"],
      ownedParts: ["内存"],
      ownedPartDetails: [{ partType: "memory", model: "旧 DDR4", specs: { memoryType: "DDR4" } }],
      workloadProfile: "balanced",
      budget: { mode: "hard", amount: 3000, currency: "CNY", hardCap: true, scope: "target_parts" },
      missingFields: [],
    });

    expect(result.requirements.targetParts).toEqual(["cpu", "motherboard"]);
    expect(result.requirements.ownedParts).toEqual(["memory"]);
    expect(result.budget?.slots.map((slot) => slot.partType)).toEqual(["cpu", "motherboard"]);
  });

  it("treats a prebuilt as one whole-device budget slot", () => {
    const result = normalizeComputerRequirementDraft({
      status: "ready",
      intent: "prebuilt_desktop",
      deviceType: "desktop",
      requiresProductSearch: true,
      workloadProfile: "gaming",
      budget: { mode: "hard", amount: 7000, currency: "CNY", hardCap: true, scope: "single_device" },
      missingFields: [],
    });

    expect(result.requirements.targetParts).toEqual(["system"]);
    expect(result.budget?.slots).toHaveLength(1);
    expect(result.budget?.slots[0]?.partType).toBe("system");
  });

  it("includes display and input devices only when an all-in DIY budget requests them", () => {
    const result = normalizeComputerRequirementDraft({
      status: "ready",
      intent: "diy_full",
      deviceType: "desktop",
      requiresProductSearch: true,
      useCases: ["游戏"],
      workloadProfile: "gaming",
      budget: { mode: "hard", amount: 10000, currency: "CNY", hardCap: true, scope: "all_in" },
      missingFields: [],
    });

    expect(result.requirements.targetParts).toEqual(expect.arrayContaining(["monitor", "keyboard", "mouse"]));
    expect(result.budget?.slots.map((slot) => slot.partType)).toEqual(expect.arrayContaining(["monitor", "keyboard", "mouse"]));
    expect(result.budget?.slots.reduce((sum, slot) => sum + slot.targetPrice, 0))
      .toBe(result.budget?.allocationTotal);
  });

  it("uses a tower-first assumption instead of blocking an ambiguous full-build recommendation", () => {
    const result = normalizeComputerRequirementDraft({
      status: "needs_clarification",
      intent: "diy_full",
      deviceType: "desktop",
      requiresProductSearch: true,
      useCases: [],
      workloadProfile: "balanced",
      budget: { mode: "hard", amount: 6000, currency: "CNY", hardCap: true, scope: "unknown" },
      missingFields: ["主要用途"],
    }, "6000 元给我推荐一套电脑");

    expect(result.requirements.status).toBe("ready");
    expect(result.requirements.budget.scope).toBe("tower");
    expect(result.requirements.assumptions).toContain("预算暂按仅主机计算，不包含显示器、键盘和鼠标");
    expect(result.requirements.missingFields).toContain("预算是否需要包含显示器、键盘和鼠标");
    expect(result.needsPlan).toBe(true);
  });

  it("delivers a complete baseline before questions when a shopping budget is missing", () => {
    const result = normalizeComputerRequirementDraft({
      status: "needs_clarification",
      intent: "diy_full",
      deviceType: "desktop",
      requiresProductSearch: true,
      useCases: ["综合使用"],
      workloadProfile: "balanced",
      budget: { mode: "unknown", currency: "CNY", hardCap: false, scope: "tower" },
      missingFields: ["总预算"],
    }, "给我推荐一套电脑");
    const prompt = typeof result.advisorPrompt === "string"
      ? result.advisorPrompt
      : result.advisorPrompt.prompt;

    expect(result.needsPlan).toBe(false);
    expect(prompt).toContain("先给出完整推荐清单");
    expect(prompt).toContain("问题统一放在回答最后");
    expect(prompt).toContain("不能用提问代替本轮推荐");
  });

  it("keeps an upgrade scoped to replacement parts and treats the old machine as constraints", () => {
    const result = normalizeComputerRequirementDraft({
      status: "ready",
      intent: "upgrade",
      deviceType: "desktop",
      requiresProductSearch: true,
      targetParts: ["cpu", "motherboard"],
      ownedParts: ["memory", "gpu", "psu", "case"],
      ownedPartDetails: [{ partType: "memory", specs: { memoryType: "DDR4" } }],
      workloadProfile: "balanced",
      budget: { mode: "hard", amount: 3000, currency: "CNY", hardCap: true, scope: "target_parts" },
      missingFields: [],
    });

    expect(result.requirements.targetParts).toEqual(["cpu", "motherboard"]);
    expect(result.budget?.slots.map((slot) => slot.partType)).toEqual(["cpu", "motherboard"]);
    expect(result.requirements.ownedPartDetails[0]?.specs).toEqual({ memoryType: "DDR4" });
  });

  it("routes knowledge and tiered no-budget requests directly to an answer", () => {
    const knowledge = normalizeComputerRequirementDraft({
      status: "ready",
      intent: "knowledge",
      deviceType: "unknown",
      requiresProductSearch: false,
      workloadProfile: "balanced",
      budget: { mode: "unknown", currency: "CNY", hardCap: false, scope: "unknown" },
      missingFields: [],
    });
    const tiered = normalizeComputerRequirementDraft({
      status: "ready",
      intent: "parts",
      deviceType: "desktop",
      requiresProductSearch: false,
      targetParts: ["gpu"],
      workloadProfile: "gaming",
      budget: { mode: "tiered", currency: "CNY", hardCap: false, scope: "target_parts" },
      missingFields: [],
    });

    expect(knowledge.needsPlan).toBe(false);
    expect(tiered.needsPlan).toBe(false);
    expect(tiered.requirements.status).toBe("ready");
  });

  it("routes configuration diagnosis without a product search", () => {
    const result = normalizeComputerRequirementDraft({
      status: "ready",
      intent: "diagnose",
      deviceType: "desktop",
      requiresProductSearch: false,
      ownedParts: ["cpu", "gpu", "memory"],
      workloadProfile: "gaming",
      budget: { mode: "unknown", currency: "CNY", hardCap: false, scope: "unknown" },
      missingFields: [],
    });

    expect(result.needsPlan).toBe(false);
    expect(result.requirements.requiresProductSearch).toBe(false);
    expect(result.requirements.ownedParts).toEqual(["cpu", "gpu", "memory"]);
  });

  it("rejects queries for parts outside the approved scope", () => {
    const policy = normalizeComputerRequirementDraft({
      status: "ready",
      intent: "parts",
      deviceType: "desktop",
      requiresProductSearch: true,
      targetParts: ["cpu", "motherboard"],
      workloadProfile: "balanced",
      budget: { mode: "hard", amount: 3000, currency: "CNY", hardCap: true, scope: "target_parts" },
      missingFields: [],
    });
    const plan = normalizeComputerTechnicalPlan({
      queries: [
        query("cpu-a", "cpu", "AMD Ryzen 处理器", 80, { socket: "AM5", tdpW: 65 }),
        query("board-a", "motherboard", "B650 主板", 80, { socket: "AM5", memoryType: "DDR5" }),
        query("gpu-a", "gpu", "不应查询的显卡", 99, {}),
      ],
    }, policy.requirements, policy.budget, undefined, 8);

    expect(plan.plan.queries.map((item) => item.partType)).toEqual(["cpu", "motherboard"]);
    expect(plan.plan.errors).not.toContain("缺少 cpu 候选查询");
  });

  it("does not turn the budget slot minimum into a commerce search floor", () => {
    const policy = partsPolicy();
    const plan = normalizeComputerTechnicalPlan({
      queries: [
        { ...query("cpu-a", "cpu", "AMD Ryzen 处理器", 80, { socket: "AM5" }), minPrice: 1800 },
        { ...query("board-a", "motherboard", "B650 主板", 80, { socket: "AM5" }), minPrice: 900 },
      ],
    }, policy.requirements, policy.budget, undefined, 8);

    expect(plan.plan.queries.every((item) => item.minPrice === undefined && item.maxPrice === undefined)).toBe(true);
  });

  it("selects a compatible combination without crossing a hard cap", () => {
    const policy = partsPolicy();
    const plan = scopedPlan(policy.requirements, policy.budget);
    const products = [
      product("cpu-a", "cpu", "cpu-1", 1700, { socket: "AM5", tdpW: 65 }),
      product("board-a", "motherboard", "board-1", 1000, { socket: "AM5", memoryType: "DDR5" }),
    ];
    const result = optimizeComputerRecommendation({
      requirements: policy.requirements,
      budget: policy.budget,
      technicalPlan: plan.plan,
      queries: plan.plan.queries,
      products,
      errors: [],
      commerceSummary: { enabled: true },
      round: 0,
      maxRepairRounds: 2,
    });

    expect(result.state.budgetStatus).toBe("within_budget");
    expect(result.state.selectedTotal).toBe(2700);
    expect(result.state.selectedProducts).toHaveLength(2);
    expect(result.needsRepair).toBe(false);
  });

  it("does not present an over-budget combination and requests a bounded repair", () => {
    const policy = partsPolicy();
    const plan = scopedPlan(policy.requirements, policy.budget);
    const result = optimizeComputerRecommendation({
      requirements: policy.requirements,
      budget: policy.budget,
      technicalPlan: plan.plan,
      queries: plan.plan.queries,
      products: [
        product("cpu-a", "cpu", "cpu-expensive", 2500, { socket: "AM5", tdpW: 65 }),
        product("board-a", "motherboard", "board-expensive", 1500, { socket: "AM5", memoryType: "DDR5" }),
      ],
      commerceSummary: { enabled: true },
      round: 0,
      maxRepairRounds: 2,
    });

    expect(result.state.budgetStatus).toBe("infeasible");
    expect(result.state.selectedProducts).toEqual([]);
    expect(result.needsRepair).toBe(true);
    expect(result.state.repairTargets.length).toBeGreaterThan(0);
  });

  it("keeps verified partial candidates visible while a full build is incomplete", () => {
    const policy = partsPolicy();
    const plan = scopedPlan(policy.requirements, policy.budget);
    const result = optimizeComputerRecommendation({
      requirements: policy.requirements,
      budget: policy.budget,
      technicalPlan: plan.plan,
      queries: plan.plan.queries,
      products: [product("cpu-a", "cpu", "cpu-verified", 1600, { socket: "AM5", tdpW: 65 })],
      commerceSummary: { enabled: true },
      round: 2,
      maxRepairRounds: 2,
    });
    const prompt = typeof result.advisorPrompt === "string"
      ? result.advisorPrompt
      : result.advisorPrompt.prompt;

    expect(result.state.budgetStatus).toBe("incomplete");
    expect(result.state.selectedProducts).toHaveLength(1);
    expect(result.state.selectedTotal).toBe(1600);
    expect(prompt).toContain("¥1600.00");
    expect(prompt).toContain("https://example.test/cpu-verified");
    expect(prompt).toContain("完整推荐清单骨架");
    expect(prompt).toContain("| CPU | cpu candidate | 系统已匹配 ¥1600.00");
    expect(prompt).toContain("| 主板 | B650 主板 | 本轮未匹配到实时商品");
    expect(prompt).toContain("最后才给“问题与待确认项”");
    expect(prompt).toContain("不得逐项要求用户自行搜索、核价或核验");
  });

  it("blocks a socket mismatch before final recommendation", () => {
    const policy = partsPolicy();
    const plan = scopedPlan(policy.requirements, policy.budget);
    const result = optimizeComputerRecommendation({
      requirements: policy.requirements,
      budget: policy.budget,
      technicalPlan: plan.plan,
      queries: plan.plan.queries,
      products: [
        product("cpu-a", "cpu", "cpu-1", 1500, { socket: "AM5", tdpW: 65 }),
        product("board-a", "motherboard", "board-1", 1000, { socket: "LGA1700", memoryType: "DDR5" }),
      ],
      commerceSummary: { enabled: true },
      round: 0,
      maxRepairRounds: 2,
    });

    expect(result.state.budgetStatus).toBe("infeasible");
    expect(result.state.compatibilityIssues).toContainEqual(expect.objectContaining({
      severity: "error",
      code: "cpu_socket",
    }));
    expect(result.state.repairTargets).toEqual(expect.arrayContaining(["cpu", "motherboard"]));
  });

  it("repairs every missing full-build slot instead of retrying only the first three", () => {
    const policy = normalizeComputerRequirementDraft({
      status: "ready",
      intent: "diy_full",
      deviceType: "desktop",
      requiresProductSearch: true,
      targetParts: [],
      workloadProfile: "gaming",
      budget: { mode: "hard", amount: 8000, currency: "CNY", hardCap: true, scope: "tower" },
      missingFields: [],
    });
    const plan = normalizeComputerTechnicalPlan({
      queries: policy.requirements.targetParts.map((part) => query(part, part, `${part} candidate`, 70, {})),
    }, policy.requirements, policy.budget, undefined, 8);
    const result = optimizeComputerRecommendation({
      requirements: policy.requirements,
      budget: policy.budget,
      technicalPlan: plan.plan,
      queries: plan.plan.queries,
      products: [],
      commerceSummary: { enabled: true },
      round: 0,
      maxRepairRounds: 2,
    });

    expect(result.state.repairTargets).toEqual(policy.requirements.targetParts);
    expect(result.state.repairTargets).toHaveLength(8);
  });

  it("retains whole-plan compatibility specs when commerce only matches one slot", () => {
    const policy = normalizeComputerRequirementDraft({
      status: "ready",
      intent: "diy_full",
      deviceType: "desktop",
      requiresProductSearch: true,
      targetParts: [],
      workloadProfile: "gaming",
      budget: { mode: "hard", amount: 8000, currency: "CNY", hardCap: true, scope: "tower" },
      missingFields: [],
    });
    const queries = [
      query("cpu", "cpu", "Ryzen 5 7500F", 80, { socket: "AM5" }),
      query("motherboard", "motherboard", "B760M 主板", 70, { socket: "LGA1700", memoryType: "DDR5" }),
      query("memory", "memory", "DDR5 内存", 70, { memoryType: "DDR5" }),
      query("storage", "storage", "1TB NVMe 固态硬盘", 70, {}),
    ];
    const issues = validateCompatibility(policy.requirements, [
      product("storage", "storage", "storage-1", 500, {}),
    ], queries);

    expect(issues).toContainEqual(expect.objectContaining({ code: "cpu_socket", severity: "error" }));
    expect(issues).not.toContainEqual(expect.objectContaining({ code: "unknown_cpu_socket" }));
  });

  it("treats a 6+2-pin PCIe plug as an 8-pin GPU connector and checks quantity", () => {
    const policy = normalizeComputerRequirementDraft({
      status: "ready",
      intent: "parts",
      deviceType: "desktop",
      requiresProductSearch: true,
      targetParts: ["gpu", "psu"],
      workloadProfile: "gaming",
      budget: { mode: "hard", amount: 5000, currency: "CNY", hardCap: true, scope: "target_parts" },
      missingFields: [],
    });
    const oneRequired = validateCompatibility(policy.requirements, [], [
      query("gpu", "gpu", "GPU", 80, { requiredConnectors: ["8-pin"] }),
      query("psu", "psu", "PSU", 80, { wattage: 750, connectors: ["24-pin", "8-pin CPU", "6+2-pin PCIe"] }),
    ]);
    const twoRequired = validateCompatibility(policy.requirements, [], [
      query("gpu", "gpu", "GPU", 80, { requiredConnectors: ["8-pin PCIe", "8-pin PCIe"] }),
      query("psu", "psu", "PSU", 80, { wattage: 750, connectors: ["6+2-pin PCIe"] }),
    ]);

    expect(oneRequired).not.toContainEqual(expect.objectContaining({ code: "psu_connector" }));
    expect(twoRequired).toContainEqual(expect.objectContaining({ code: "psu_connector" }));
  });

  it("keeps budget search windows out of the final product prompt", () => {
    const policy = partsPolicy();
    const plan = scopedPlan(policy.requirements, policy.budget);
    const result = optimizeComputerRecommendation({
      requirements: policy.requirements,
      budget: policy.budget,
      technicalPlan: plan.plan,
      queries: plan.plan.queries,
      products: [
        product("cpu-a", "cpu", "cpu-verified", 1700, { socket: "AM5", tdpW: 65 }),
        product("board-a", "motherboard", "board-verified", 1000, { socket: "AM5", memoryType: "DDR5" }),
      ],
      commerceSummary: { enabled: true },
    });
    const prompt = typeof result.advisorPrompt === "string"
      ? result.advisorPrompt
      : result.advisorPrompt.prompt;

    expect(prompt).toContain("已核验实时商品候选");
    expect(prompt).toContain("¥1700.00");
    expect(prompt).toContain("https://example.test/cpu-verified");
    expect(prompt).not.toContain('"minPrice"');
    expect(prompt).not.toContain('"maxPrice"');
  });
});

function partsPolicy() {
  return normalizeComputerRequirementDraft({
    status: "ready",
    intent: "parts",
    deviceType: "desktop",
    requiresProductSearch: true,
    targetParts: ["cpu", "motherboard"],
    workloadProfile: "balanced",
    budget: { mode: "hard", amount: 3000, currency: "CNY", hardCap: true, scope: "target_parts" },
    missingFields: [],
  });
}

function scopedPlan(requirements: unknown, budget: unknown) {
  return normalizeComputerTechnicalPlan({
    queries: [
      query("cpu-a", "cpu", "AMD Ryzen 处理器", 80, { socket: "AM5", tdpW: 65 }),
      query("board-a", "motherboard", "B650 主板", 80, { socket: "AM5", memoryType: "DDR5" }),
    ],
  }, requirements, budget, undefined, 8);
}

function query(
  queryId: string,
  partType: string,
  keyword: string,
  utilityScore: number,
  requiredSpecs: Record<string, unknown>,
): AffiliateProductQuery {
  return { queryId, slotId: partType, partType, keyword, utilityScore, requiredSpecs, count: 2 };
}

function product(
  queryId: string,
  partType: string,
  productId: string,
  price: number,
  requiredSpecs: Record<string, unknown>,
): AffiliateProduct {
  return {
    provider: "pdd",
    productId,
    name: `${partType} candidate`,
    price,
    promotionUrl: `https://example.test/${productId}`,
    hasCoupon: false,
    capturedAt: "2026-08-10T00:00:00.000Z",
    affiliate: true,
    queryId,
    slotId: partType,
    partType,
    utilityScore: 80,
    requiredSpecs,
    candidateRank: 0,
  };
}
