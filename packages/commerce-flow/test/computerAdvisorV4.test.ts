import { describe, expect, it } from "vitest";
import type { AffiliateProduct } from "../src/commerce";
import {
  type ComputerAdvisorStateV4,
  type ComputerBlueprintV4,
  type ComputerCommerceQueryV4,
  type ComputerRequirementsV4,
  assembleComputerReportV4,
  guardComputerBlueprintV4,
  guardComputerReportV4,
  normalizeComputerRequirementV4,
  optimizeComputerRecommendationV4,
  scheduleComputerCommerceQueriesV4,
  verifyComputerCandidateV4,
} from "../src/computerAdvisorV4";

const FULL_TOWER_PARTS = [
  "cpu",
  "cooler",
  "motherboard",
  "memory",
  "gpu",
  "storage",
  "psu",
  "case",
] as const;

function makeFullBuild(): {
  requirements: ComputerRequirementsV4;
  blueprint: ComputerBlueprintV4;
  state: ComputerAdvisorStateV4;
} {
  const policy = normalizeComputerRequirementV4({
    intent: "diy_full",
    deviceType: "desktop",
    useCases: ["2K 游戏"],
    workloadProfile: "gaming",
    region: "中国大陆",
    budget: {
      mode: "hard",
      amount: 6_000,
      currency: "CNY",
      hardCap: true,
      scope: "tower",
    },
  }, "预算 6000 元，只含主机，玩 2K 游戏");
  const guarded = guardComputerBlueprintV4(undefined, policy.requirements);
  return {
    requirements: guarded.requirements,
    blueprint: guarded.blueprint,
    state: guarded.state,
  };
}

function makeSingleStorageBuild(): {
  requirements: ComputerRequirementsV4;
  blueprint: ComputerBlueprintV4;
  state: ComputerAdvisorStateV4;
} {
  const policy = normalizeComputerRequirementV4({
    intent: "parts",
    deviceType: "desktop",
    targetParts: ["storage"],
    useCases: ["游戏"],
    workloadProfile: "gaming",
    budget: {
      mode: "hard",
      amount: 800,
      currency: "CNY",
      hardCap: true,
      scope: "target_parts",
    },
  }, "推荐一块 800 元以内的内置 NVMe 固态硬盘");
  const guarded = guardComputerBlueprintV4(undefined, policy.requirements);
  return {
    requirements: guarded.requirements,
    blueprint: guarded.blueprint,
    state: guarded.state,
  };
}

function makeProduct(
  query: ComputerCommerceQueryV4,
  overrides: Partial<AffiliateProduct> = {},
): AffiliateProduct {
  return {
    provider: "pdd",
    productId: `product-${query.slotId}-${query.attempt}`,
    name: `${query.keyword} 正品`,
    price: 499,
    hasCoupon: false,
    capturedAt: "2026-08-11T12:00:00.000Z",
    affiliate: true,
    queryId: query.queryId,
    slotId: query.slotId,
    coveredSlotIds: query.coveredSlotIds,
    partType: query.partType,
    sourceUrl: "https://mobile.yangkeduo.com/goods.html?goods_id=123",
    ...overrides,
  };
}

function collectObjectKeys(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, nested] of Object.entries(value)) {
    output.add(key);
    collectObjectKeys(nested, output);
  }
  return output;
}

function expectNoUserVerificationHandoff(markdown: string): void {
  expect(markdown).not.toMatch(/请用户自行(?:核验|核价|搜索)/);
  expect(markdown).not.toMatch(/自行(?:核验|核价|搜索)/);
  expect(markdown).not.toContain("请自行确认商品");
}

function scheduleFullAttempt(
  blueprint: ComputerBlueprintV4,
  state: ComputerAdvisorStateV4,
  attempt: number,
  nowMs: number,
) {
  let current = state;
  let scheduled = scheduleComputerCommerceQueriesV4(blueprint, current, {
    maxWaveQueries: 8,
    maxTotalQueries: 40,
    maxAttemptsPerSlot: 5,
    wallClockLimitMs: 120_000,
    nowMs,
  });
  for (let currentAttempt = 1; currentAttempt < attempt; currentAttempt += 1) {
    current = scheduled.state;
    scheduled = scheduleComputerCommerceQueriesV4(blueprint, current, {
      maxWaveQueries: 8,
      maxTotalQueries: 40,
      maxAttemptsPerSlot: 5,
      wallClockLimitMs: 120_000,
      nowMs: nowMs + currentAttempt,
    });
  }
  return scheduled;
}

function pricedBuild(prices: number[], budget = 8000) {
  const fixture = makeFullBuild();
  fixture.requirements.budget.amount = budget;
  fixture.state.requirements = fixture.requirements;
  const scheduled = scheduleComputerCommerceQueriesV4(fixture.blueprint, fixture.state, { maxWaveQueries: 8, nowMs: 1000 });
  const products = scheduled.queryPlan.queries.map((query, index) => makeProduct(query, {
    name: `${fixture.blueprint.slots[index]!.primaryModel} ${query.categoryAnchors[0]}`, price: prices[index]!,
  }));
  const result = optimizeComputerRecommendationV4({ ...fixture, queries: scheduled.queryPlan, products,
    previousState: scheduled.state, nowMs: 1100 });
  expect(result.state.diagnostics.candidateRejections).toEqual([]);
  return { ...fixture, state: result.state };
}

function priceNext(fixture: ReturnType<typeof pricedBuild>, price: number) {
  const scheduled = scheduleComputerCommerceQueriesV4(fixture.blueprint, fixture.state, { maxWaveQueries: 1, nowMs: 1200 });
  const query = scheduled.queryPlan.queries[0]!;
  expect(query).toBeDefined();
  const slot = fixture.blueprint.slots.find((item) => item.slotId === query.slotId)!;
  const direction = fixture.state.scheduler.requestedAlternatives[slot.slotId];
  const result = optimizeComputerRecommendationV4({ ...fixture, queries: scheduled.queryPlan,
    products: [makeProduct(query, { name: `${slot.alternatives.find((item) => item.direction === direction)!.model} ${query.categoryAnchors[0]}`, price })],
    previousState: scheduled.state, nowMs: 1300 });
  return { ...fixture, state: result.state };
}

describe("budget feedback loop", () => {
  it("upgrades multiple useful parts until a complete 8000-budget build reaches the target band", () => {
    const initial = pricedBuild([800, 100, 600, 400, 2000, 400, 300, 200]);
    expect(initial.state.selectedSubtotal).toBe(4800);
    expect(initial.state.scheduler.requestedAlternatives).toEqual({ "slot-gpu": "higher_performance" });
    const gpu = priceNext(initial, 3500);
    expect(gpu.state.selectedSubtotal).toBe(6300);
    expect(gpu.state.scheduler.requestedAlternatives).toEqual({ "slot-cpu": "higher_performance" });
    const cpu = priceNext(gpu, 1800);
    expect(cpu.state.selectedSubtotal).toBe(7300);
    expect(cpu.state.coverage.budget).toBe("verified_within_budget");
    expect(cpu.state.stopReason).toBe("all_slots_priced");
    expect(cpu.state.candidatePool.length).toBeGreaterThan(initial.state.candidatePool.length);
  });

  it("reduces several parts using real prices while retaining a complete configuration", () => {
    let fixture = pricedBuild([1500, 300, 1800, 700, 4000, 800, 700, 700]);
    expect(fixture.state.selectedSubtotal).toBe(10500);
    expect(fixture.state.stopReason).toBeNull();
    let rounds = 0;
    while (fixture.state.stopReason === null && rounds++ < 8) {
      const slotId = Object.keys(fixture.state.scheduler.requestedAlternatives)[0]!;
      expect(fixture.state.scheduler.requestedAlternatives[slotId]).toBe("lower_cost");
      const oldPrice = fixture.state.selectedCandidates.find((item) => item.slotId === slotId)!.comparablePrice;
      fixture = priceNext(fixture, Math.round(oldPrice * 0.5));
    }
    expect(rounds).toBeGreaterThan(1);
    expect(fixture.state.coverage.pricing.verified).toBe(8);
    expect(fixture.state.selectedSubtotal).toBeLessThanOrEqual(8000);
    expect(fixture.state.coverage.budget).toBe("verified_within_budget");
  });

  it("keeps the affordable original when an upgrade is too expensive", () => {
    const fixture = pricedBuild([800, 100, 600, 400, 2000, 400, 300, 200]);
    const attempted = priceNext(fixture, 7000);
    expect(attempted.state.selectedSubtotal).toBe(4800);
    expect(attempted.state.selectedCandidates.find((item) => item.partType === "gpu")?.name)
      .toBe(fixture.state.selectedCandidates.find((item) => item.partType === "gpu")?.name);
  });

  it.each(["commerce_unavailable", "wall_clock_exhausted", "query_budget_exhausted"] as const)("cannot override %s to keep repairing an over-budget build", (reason) => {
    const fixture = pricedBuild([1500, 300, 1800, 700, 4000, 800, 700, 700]);
    if (reason === "query_budget_exhausted") fixture.state.scheduler.totalIssued = fixture.state.scheduler.maxTotalQueries;
    const result = optimizeComputerRecommendationV4({ ...fixture, previousState: fixture.state,
      nowMs: reason === "wall_clock_exhausted" ? 600000 : 1300,
      errors: reason === "commerce_unavailable" ? ["商品服务不可用：需要登录"] : [] });
    expect(result.state.stopReason).toBe(reason);
    expect(result.needsRepair).toBe(false);
    expect(scheduleComputerCommerceQueriesV4(fixture.blueprint, result.state, { nowMs: 1400 }).queryPlan.queries).toEqual([]);
  });

  it("does not infer spare budget from a partial subtotal", () => {
    const fixture = makeFullBuild();
    const scheduled = scheduleComputerCommerceQueriesV4(fixture.blueprint, fixture.state, { maxWaveQueries: 1, nowMs: 1000 });
    const result = optimizeComputerRecommendationV4({ ...fixture, queries: scheduled.queryPlan,
      products: [makeProduct(scheduled.queryPlan.queries[0]!, { price: 800 })], previousState: scheduled.state, nowMs: 1100 });
    expect(result.state.scheduler.requestedAlternatives).toEqual({});
    expect(result.needsRepair).toBe(true);
  });

  it("rejects one display price shared by multiple CPU models", () => {
    const fixture = makeFullBuild();
    const query = scheduleComputerCommerceQueriesV4(fixture.blueprint, fixture.state, { nowMs: 1000 }).queryPlan.queries[0]!;
    expect(verifyComputerCandidateV4({ query, slot: fixture.blueprint.slots[0]!, product: makeProduct(query, {
      sourceKind: "browser", detailVerified: true, name: "R5-7500F R5-7400F R5-8400F R5-7600 R5-7600X R5-8500G", price: 480,
    }) })).toMatchObject({ reasons: expect.arrayContaining(["ambiguous_model_price"]) });
  });

  it("prints only linked, selected rows and computes their subtotal without public estimates", () => {
    const fixture = pricedBuild([800, 100, 600, 400, 2000, 400, 300, 200]);
    const selected = fixture.state.selectedCandidates.find((candidate) => candidate.partType === "cpu")!;
    const report = assembleComputerReportV4({ ...fixture, products: [{
      provider: selected.provider, productId: selected.productId, slotId: selected.slotId, name: selected.name,
      price: selected.comparablePrice, hasCoupon: false, affiliate: false, sourceKind: "browser", detailVerified: true,
      sourceUrl: "https://mobile.yangkeduo.com/goods.html?goods_id=123", capturedAt: selected.capturedAt,
    }] }).report;
    expect(report.markdown).toContain("已核价小计：¥800（1/8 项");
    expect(report.markdown).not.toContain("¥4,800");
    expect(report.markdown.match(/^## /gm)).toHaveLength(2);
    expect(report.markdown).not.toMatch(/推广|公开市场|供给源诊断/);
    expect(guardComputerReportV4(report, report.markdown).accepted).toBe(true);
  });
});

describe("computer advisor V4 structural policies", () => {
  it("falls back to deterministic requirement rules when the LLM draft is invalid", () => {
    const result = normalizeComputerRequirementV4(
      "{ this is not valid JSON",
      "预算 6000 元，只含主机，帮我装一台玩 2K 游戏的电脑",
    );

    expect(result.needsBlueprint).toBe(true);
    expect(result.requirements.intent).toBe("diy_full");
    expect(result.requirements.targetParts).toEqual(FULL_TOWER_PARTS);
    expect(result.requirements.budget.amount).toBe(6_000);
    expect(result.requirements.systemNotes).toContain(
      "需求草案无法解析，已使用原始请求的确定性规则回退",
    );
  });

  it("fills every missing full-tower slot and strips all price-like blueprint fields", () => {
    const { requirements } = makeFullBuild();
    const result = guardComputerBlueprintV4({
      slots: [{
        partType: "cpu",
        primaryModel: "AMD Ryzen 5 7500F",
        price: 999,
        minPrice: 800,
        maxPrice: 1_100,
        targetPrice: 950,
        estimatedPrice: 980,
        requiredSpecs: {
          socket: "AM5",
          targetPrice: 950,
        },
      }],
    }, requirements);

    expect(result.blueprint.slots.map((slot) => slot.partType)).toEqual(FULL_TOWER_PARTS);
    expect(new Set(result.blueprint.slots.map((slot) => slot.slotId)).size).toBe(8);
    expect(result.state.coverage.configuration).toEqual({ required: 8, planned: 8 });
    const allKeys = collectObjectKeys(result.blueprint);
    expect([...allKeys].filter((key) => [
      "price",
      "minPrice",
      "maxPrice",
      "targetPrice",
      "estimatedPrice",
    ].includes(key))).toEqual([]);
  });

  it("accepts nested web-discovered model candidates instead of discarding them", () => {
    const { requirements } = makeFullBuild();
    const result = guardComputerBlueprintV4({
      blueprint: {
        cpu: {
          primaryModel: "AMD Ryzen 5 9600X",
          lowerCost: "AMD Ryzen 5 7500F",
          higherPerformance: "AMD Ryzen 7 9700X",
          utilityWeight: 0.25,
        },
        gpu: {
          primaryModel: "NVIDIA GeForce RTX 5070 12GB",
          lowerCost: "NVIDIA GeForce RTX 5060 Ti 16GB",
          higherPerformance: "NVIDIA GeForce RTX 5070 Ti 16GB",
          utilityWeight: 0.35,
        },
      },
    }, requirements);

    const cpu = result.blueprint.slots.find((slot) => slot.partType === "cpu")!;
    const gpu = result.blueprint.slots.find((slot) => slot.partType === "gpu")!;
    expect(cpu.primaryModel).toBe("AMD Ryzen 5 9600X");
    expect(cpu.alternatives).toEqual(expect.arrayContaining([
      { model: "AMD Ryzen 5 7500F", direction: "lower_cost" },
      { model: "AMD Ryzen 7 9700X", direction: "higher_performance" },
    ]));
    expect(cpu.utilityWeight).toBe(25);
    expect(gpu.primaryModel).toBe("NVIDIA GeForce RTX 5070 12GB");
  });

  it("canonicalizes model specs without leaking an unrelated fallback platform", () => {
    const { requirements } = makeFullBuild();
    const result = guardComputerBlueprintV4({
      slots: [
        { partType: "cpu", primaryModel: "Intel Core i5-14600K", alternatives: [
          { model: "AMD Ryzen 5 7500F", direction: "lower_cost" },
          { model: "Intel Core i7-14700K", direction: "higher_performance" },
        ], requiredSpecs: { socket: "LGA1700", tdp: 125 } },
        { partType: "cooler", primaryModel: "利民 PA120", requiredSpecs: { socketSupport: "LGA1700", height: 157 } },
        { partType: "motherboard", primaryModel: "微星 PRO B760M-A DDR4", requiredSpecs: { socket: "LGA1700", memoryType: "DDR4", formFactor: "mATX" } },
        { partType: "memory", primaryModel: "金士顿 Fury DDR4-3200 32GB", requiredSpecs: { type: "DDR4", capacity: 32 } },
        { partType: "gpu", primaryModel: "NVIDIA GeForce RTX 5060 Ti 16GB", requiredSpecs: { vram: 16, tdp: 180 } },
        { partType: "storage", primaryModel: "Samsung 980 PRO 1TB", requiredSpecs: { capacity: 1, interface: "NVMe", formFactor: "M.2 2280" } },
        { partType: "psu", primaryModel: "Corsair RM650x 650W", requiredSpecs: { wattage: 650 } },
        { partType: "case", primaryModel: "联力 LANCOOL 216 ATX", requiredSpecs: { supportedMotherboardFormFactors: "ATX", gpuLength: 392, coolerHeight: 180 } },
      ],
    }, requirements);

    const byPart = new Map(result.blueprint.slots.map((slot) => [slot.partType, slot]));
    expect(byPart.get("cpu")?.primaryModel).toBe("Intel Core i5-14600K");
    expect(byPart.get("cpu")?.requiredSpecs).toMatchObject({ socket: "LGA1700", tdpW: 125 });
    expect(byPart.get("cpu")?.alternatives).toEqual([
      { model: "Intel Core i7-14700K", direction: "higher_performance" },
    ]);
    expect(byPart.get("cooler")?.requiredSpecs).toMatchObject({ socketSupport: ["LGA1700"], heightMm: 157 });
    expect(byPart.get("memory")?.requiredSpecs).toMatchObject({ memoryType: "DDR4", capacityGB: 32 });
    expect(byPart.get("gpu")?.requiredSpecs).not.toHaveProperty("recommendedPsuW");
    expect(byPart.get("storage")?.requiredSpecs.capacityGB).toBe(1_000);
    expect(byPart.get("case")?.requiredSpecs.supportedMotherboardFormFactors)
      .toEqual(["ATX", "mATX", "Mini-ITX"]);
    expect(result.state.compatibilityIssues).toEqual([]);
    expect(result.state.coverage.compatibility).toBe("passed");
  });

  it("falls back as a whole when a generated blueprint has a real platform conflict", () => {
    const { requirements } = makeFullBuild();
    const result = guardComputerBlueprintV4({ slots: [
      { partType: "cpu", primaryModel: "Intel Core i5-14600K", requiredSpecs: { socket: "LGA1700" } },
      { partType: "motherboard", primaryModel: "微星 B650M MORTAR WIFI", requiredSpecs: { socket: "AM5", memoryType: "DDR5" } },
    ] }, requirements);

    expect(result.blueprint.slots.find((slot) => slot.partType === "cpu")?.primaryModel)
      .toBe("AMD Ryzen 5 7500F");
    expect(result.blueprint.notes.join(" ")).toContain("已整体回退到一致的确定性平台");
    expect(result.state.coverage.compatibility).toBe("passed");
  });

  it("bounds missing-product searches to concrete primary and alternative models", () => {
    const { blueprint, state: initialState } = makeFullBuild();
    let state = initialState;
    const issued: ComputerCommerceQueryV4[] = [];

    for (let wave = 0; wave < 10; wave += 1) {
      const scheduled = scheduleComputerCommerceQueriesV4(blueprint, state, {
        maxWaveQueries: 4,
        maxTotalQueries: 40,
        maxAttemptsPerSlot: 5,
        wallClockLimitMs: 120_000,
        nowMs: 10_000 + wave,
      });
      issued.push(...scheduled.queryPlan.queries);
      state = scheduled.state;
    }

    expect(issued.length).toBeGreaterThanOrEqual(16);
    expect(issued.length).toBeLessThanOrEqual(24);
    expect(issued.slice(0, 8).every((query) => query.attempt === 1)).toBe(true);
    expect(new Set(issued.map((query) => query.stage))).toEqual(new Set(["exact_model", "approved_alternative"]));
    expect(state.stopReason).toBe("attempts_exhausted");
    const cpuExact = issued.find((query) => query.partType === "cpu" && query.attempt === 1)!;
    const gpuExact = issued.find((query) => query.partType === "gpu" && query.attempt === 1)!;
    expect(cpuExact).toMatchObject({ stage: "exact_model", keyword: "7500F 处理器", modelAnchors: ["7500f"] });
    expect(gpuExact.keyword).toBe("RX 7800 XT");
    expect(gpuExact.modelAnchors).toEqual(["7800xt"]);
    expect(new Set(issued.map((query) => query.fingerprint)).size).toBe(issued.length);
    for (const query of issued) {
      expect(query).not.toHaveProperty("minPrice");
      expect(query).not.toHaveProperty("maxPrice");
      expect(query).not.toHaveProperty("targetPrice");
      expect(query.discoveryMode).toBe("unbounded");
      expect(query.negativeTerms).toEqual(expect.arrayContaining(["拆机", "二手", "翻新"]));
    }
  });

  it("rejects dismantled and used listings even when model and category match", () => {
    const { blueprint, state } = makeFullBuild();
    const scheduled = scheduleComputerCommerceQueriesV4(blueprint, state, {
      maxWaveQueries: 8,
      maxTotalQueries: 40,
      maxAttemptsPerSlot: 5,
      nowMs: 45_000,
    });
    const query = scheduled.queryPlan.queries.find((item) => item.partType === "psu")!;
    const slot = blueprint.slots.find((item) => item.partType === "psu")!;
    const result = verifyComputerCandidateV4({
      query,
      slot,
      product: makeProduct(query, {
        name: "拆机 酷冷至尊 MWE Gold 750 V2 额定750W金牌电源",
        price: 238,
      }),
    });

    expect(result).not.toHaveProperty("verificationStatus");
    expect(("reasons" in result ? result.reasons : []).join(" ")).toContain("拆机");
  });



  it("rejects a USB external drive before it can enter the NVMe candidate pool", () => {
    const { blueprint, state } = makeSingleStorageBuild();
    const scheduled = scheduleComputerCommerceQueriesV4(blueprint, state, {
      maxWaveQueries: 1,
      maxTotalQueries: 3,
      maxAttemptsPerSlot: 3,
      nowMs: 80_000,
    });
    const query = scheduled.queryPlan.queries[0]!;
    const slot = blueprint.slots[0]!;
    const result = verifyComputerCandidateV4({
      query,
      slot,
      product: makeProduct(query, {
        productId: "wrong-usb-drive",
        name: "USB 3.0 移动硬盘 1TB 外置便携存储",
        price: 99,
      }),
    });

    expect(result).not.toHaveProperty("verificationStatus");
    expect(result).toHaveProperty("reasons");
    if ("reasons" in result) {
      expect(result.reasons).toEqual(expect.arrayContaining([
        expect.stringMatching(/^negative_term:(移动|移动硬盘|外置)$/),
      ]));
    }
  });

  it("rejects a Mini-ITX-only case for an ATX build before it can become a priced candidate", () => {
    const fixture = makeFullBuild();
    const discovery = scheduleFullAttempt(fixture.blueprint, fixture.state, 1, 85_000);
    const query = discovery.queryPlan.queries.find((item) => item.partType === "case")!;
    const slot = fixture.blueprint.slots.find((item) => item.partType === "case")!;
    const result = verifyComputerCandidateV4({
      query,
      slot,
      product: makeProduct(query, {
        productId: "wrong-mini-itx-case",
        name: "迷你 MINI 手提 ITX 机箱 17*17 主板 小1U电源 台式机外壳",
        price: 58.8,
      }),
    });

    expect(result).not.toHaveProperty("verificationStatus");
    if ("reasons" in result) {
      expect(result.reasons).toContain("observed_spec_conflict:supportedMotherboardFormFactors");
    }
  });




  it("keeps all eight technical rows when commerce returns zero products", () => {
    const fixture = makeFullBuild();
    const assembled = assembleComputerReportV4({
      requirements: fixture.requirements,
      blueprint: fixture.blueprint,
      state: fixture.state,
      products: [],
    });
    const markdown = assembled.report.markdown;

    expect(assembled.report.requiredSlotIds).toHaveLength(8);
    expect(assembled.report.slotMarkers).toHaveLength(8);
    expect((markdown.match(/<!-- v4-slot:/g) ?? [])).toHaveLength(8);
    expect((markdown.match(/（未核价）/g) ?? [])).toHaveLength(8);
    for (const label of ["处理器", "散热器", "主板", "内存", "显卡", "存储", "电源", "机箱"]) {
      expect(markdown).toContain(`| ${label} |`);
    }
    expect(markdown).toContain("已核价 0/8 项");
    expect(markdown).toContain("表中保留计划型号");
    expect(markdown).not.toContain("待实时核价");
    expectNoUserVerificationHandoff(markdown);
  });




  it("falls back to the deterministic baseline when polishing deletes rows, changes prices, adds URLs, or fails", () => {
    const fixture = makeFullBuild();
    const assembled = assembleComputerReportV4({
      requirements: fixture.requirements,
      blueprint: fixture.blueprint,
      state: fixture.state,
      products: [],
    });
    const { report } = assembled;
    const baseline = report.markdown;
    const removedRow = baseline
      .split("\n")
      .filter((line) => !line.includes(report.slotMarkers[0]!))
      .join("\n");
    const budgetToken = report.allowedCurrencyTokens[0]!;
    const changedPrice = baseline.replace(budgetToken, budgetToken.replace(/\d/, "9"));
    const addedUrl = `${baseline}\n\n[额外商品](https://evil.example/product)`;

    const attempts = [
      guardComputerReportV4(report, removedRow),
      guardComputerReportV4(report, changedPrice),
      guardComputerReportV4(report, addedUrl),
      guardComputerReportV4(report, baseline, "polisher unavailable"),
    ];
    for (const attempt of attempts) {
      expect(attempt.accepted).toBe(false);
      expect(attempt.answer).toBe(baseline.replace(/\s*<!-- v4-slot:[^>]+ -->/g, ""));
      expect(attempt.violations.length).toBeGreaterThan(0);
    }
    expect(attempts[0]?.violations).toEqual(expect.arrayContaining([
      expect.stringMatching(/^slot_row_changed:/),
    ]));
    expect(attempts[1]?.violations).toContain("currency_fact_changed");
    expect(attempts[2]?.violations).toEqual(expect.arrayContaining([
      "unapproved_link:https://evil.example/product",
    ]));
    expect(attempts[3]?.violations).toContain("polisher_error");
  });
});
