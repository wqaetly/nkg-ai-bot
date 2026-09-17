import { describe, expect, it } from "vitest";
import type { AffiliateProduct } from "../src/commerce";
import {
  type ComputerAdvisorStateV4,
  type ComputerBlueprintV4,
  type ComputerCommerceQueryV4,
  type ComputerRequirementsV4,
  assembleComputerReportV4,
  discoverMarketClustersV4,
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

  it("searches three concrete technical models before broad market fallback", () => {
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

    expect(issued).toHaveLength(39);
    expect(issued.slice(0, 8).every((query) => query.attempt === 1)).toBe(true);
    expect(issued.findIndex((query) => query.attempt === 2)).toBe(8);
    expect(issued.filter((query) => query.attempt === 1).map((query) => query.slotId))
      .toEqual(blueprint.slots.map((slot) => slot.slotId));
    expect(issued.filter((query) => query.attempt === 2).map((query) => query.slotId))
      .toEqual(blueprint.slots.map((slot) => slot.slotId));
    expect(issued.filter((query) => query.attempt === 3).map((query) => query.slotId))
      .toEqual(blueprint.slots.map((slot) => slot.slotId));
    expect(issued.filter((query) => query.attempt === 4).map((query) => query.slotId))
      .toEqual(blueprint.slots.map((slot) => slot.slotId));
    expect(issued.filter((query) => query.attempt === 5).map((query) => query.slotId))
      .toEqual(blueprint.slots.filter((slot) => slot.partType !== "psu").map((slot) => slot.slotId));
    expect(new Set(issued.map((query) => query.stage))).toEqual(new Set([
      "market_discovery",
      "exact_model",
      "model_family",
      "approved_alternative",
    ]));
    const cpuExact = issued.find((query) => query.partType === "cpu" && query.attempt === 1)!;
    const gpuExact = issued.find((query) => query.partType === "gpu" && query.attempt === 1)!;
    expect(cpuExact).toMatchObject({ stage: "exact_model", keyword: "7500F", modelAnchors: ["7500f"] });
    expect(gpuExact.keyword).toBe("RX 7800 XT");
    expect(gpuExact.modelAnchors).toEqual(["7800xt"]);
    expect(new Set(issued.map((query) => query.fingerprint)).size).toBe(issued.length);
    for (const slot of blueprint.slots) {
      expect(new Set(
        issued.filter((query) => query.slotId === slot.slotId).map((query) => query.keyword.toLowerCase()),
      ).size).toBe(slot.partType === "psu" ? 4 : 5);
    }
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

  it("uses a concise model alias when the economy blueprint has no distinct lower candidate", () => {
    const { requirements, blueprint, state } = makeSingleStorageBuild();
    const exact = scheduleComputerCommerceQueriesV4(blueprint, state, {
      maxWaveQueries: 1,
      maxTotalQueries: 5,
      maxAttemptsPerSlot: 5,
      wallClockLimitMs: 120_000,
      nowMs: 50_000,
    });
    expect(exact.queryPlan.queries[0]?.stage).toBe("exact_model");
    expect(exact.queryPlan.queries[0]?.keyword.toLowerCase()).toContain("exceria g2");

    const afterEmptyExact = optimizeComputerRecommendationV4({
      requirements,
      blueprint,
      queries: exact.queryPlan,
      products: [],
      previousState: exact.state,
      maxNoProgressWaves: 2,
      wallClockLimitMs: 120_000,
      nowMs: 50_010,
    });
    expect(afterEmptyExact.state.stopReason).toBeNull();
    expect(afterEmptyExact.needsRepair).toBe(true);
    expect(afterEmptyExact.state.scheduler.noProgressWaves).toBe(1);

    const family = scheduleComputerCommerceQueriesV4(blueprint, afterEmptyExact.state, {
      maxWaveQueries: 1,
      maxTotalQueries: 5,
      maxAttemptsPerSlot: 5,
      wallClockLimitMs: 120_000,
      nowMs: 50_020,
    });
    expect(family.stopReason).toBeNull();
    expect(family.queryPlan.queries[0]?.stage).toBe("model_family");
    expect(family.queryPlan.queries[0]?.attempt).toBe(2);
    expect(family.queryPlan.queries[0]?.keyword.toLowerCase()).toContain("exceria g2");
  });

  it("changes strategy inside the loop when the provider returns only wrong-category goods", () => {
    const fixture = makeSingleStorageBuild();
    const exact = scheduleComputerCommerceQueriesV4(fixture.blueprint, fixture.state, {
      maxWaveQueries: 1,
      maxTotalQueries: 5,
      maxAttemptsPerSlot: 5,
      nowMs: 60_000,
    });
    const optimized = optimizeComputerRecommendationV4({
      requirements: fixture.requirements,
      blueprint: fixture.blueprint,
      queries: exact.queryPlan,
      products: [],
      telemetry: [{
        queryId: exact.queryPlan.queries[0]?.queryId,
        slotId: "slot-storage",
        partType: "storage",
        stage: "exact_model",
        attempt: 1,
        keyword: exact.queryPlan.queries[0]?.keyword ?? "",
        provider: "pdd",
        providerRawCount: 15,
        structurallyValidCount: 15,
        rejectedByCategory: 15,
        rejectedByModel: 0,
        rejectedByPrice: 0,
        acceptedCount: 0,
      }],
      previousState: exact.state,
      nowMs: 60_010,
    });
    const adaptive = scheduleComputerCommerceQueriesV4(fixture.blueprint, optimized.state, {
      maxWaveQueries: 1,
      maxTotalQueries: 5,
      maxAttemptsPerSlot: 5,
      nowMs: 60_020,
    });

    expect(adaptive.queryPlan.queries[0]).toMatchObject({
      partType: "storage",
      stage: "market_discovery",
      keyword: "NVMe固态硬盘",
    });
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
    const discovery = scheduleFullAttempt(fixture.blueprint, fixture.state, 4, 85_000);
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

  it("drops phone, tablet, and laptop coolers during broad market discovery", () => {
    const fixture = makeFullBuild();
    const scheduled = scheduleFullAttempt(fixture.blueprint, fixture.state, 4, 85_000);
    const coolerQuery = scheduled.queryPlan.queries.find((query) => query.partType === "cooler")!;
    const clusters = discoverMarketClustersV4(fixture.blueprint, scheduled.queryPlan, [
      makeProduct(coolerQuery, {
        productId: "tablet-cooler",
        name: "嘉华彩 45W 磁吸 iPad 平板半导体散热器 120帧",
        price: 102,
      }),
      makeProduct(coolerQuery, {
        productId: "laptop-cooler",
        name: "绿巨能 V10 笔记本电脑外置涡轮散热器",
        price: 209,
      }),
    ]);

    expect(clusters).toEqual([]);
  });

  it("extracts the SSD model code instead of using brand and capacity as its identity", () => {
    const fixture = makeFullBuild();
    const scheduled = scheduleFullAttempt(fixture.blueprint, fixture.state, 4, 87_000);
    const storageQuery = scheduled.queryPlan.queries.find((query) => query.partType === "storage")!;
    const clusters = discoverMarketClustersV4(fixture.blueprint, scheduled.queryPlan, [
      makeProduct(storageQuery, {
        productId: "nv3-sample",
        name: "金士顿 1TB 固态硬盘 M.2 NVMe PCIe 4.0 NV3 系列",
        price: 720,
      }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.identity.toLowerCase()).toBe("nv3");
    expect(clusters[0]?.confirmationKeyword.toLowerCase()).toContain("nv3");
    expect(clusters[0]?.confirmationKeyword).not.toContain("金士顿1tb");
  });

  it("treats a confirmed board-and-CPU bundle as one price covering two slots", () => {
    const fixture = makeFullBuild();
    const discoverySchedule = scheduleFullAttempt(fixture.blueprint, fixture.state, 4, 90_000);
    const bundleDiscovery = discoverySchedule.queryPlan.queries.find((query) => query.partType === "cpu")!;
    expect(bundleDiscovery.keyword).toContain("板U套装");
    expect(bundleDiscovery.coveredSlotIds).toEqual(["slot-cpu", "slot-motherboard"]);
    const sample = makeProduct(bundleDiscovery, {
      productId: "bundle-sample",
      name: "AMD Ryzen 5 7500F 搭 微星 B650M MORTAR WIFI 主板 板U套装",
      price: 2_099,
    });
    const discovered = optimizeComputerRecommendationV4({
      requirements: fixture.requirements,
      blueprint: fixture.blueprint,
      queries: discoverySchedule.queryPlan,
      products: [sample],
      previousState: discoverySchedule.state,
      nowMs: 90_010,
    });
    expect(discovered.state.coverage.pricing.verified).toBe(0);
    expect(discovered.state.marketDiscoveries[0]?.coveredSlotIds)
      .toEqual(["slot-cpu", "slot-motherboard"]);

    const confirmationSchedule = scheduleComputerCommerceQueriesV4(fixture.blueprint, discovered.state, {
      maxWaveQueries: 8,
      maxTotalQueries: 40,
      maxAttemptsPerSlot: 5,
      wallClockLimitMs: 120_000,
      nowMs: 90_020,
    });
    const bundleConfirmation = confirmationSchedule.queryPlan.queries.find((query) =>
      query.stage === "market_confirmation" && query.coveredSlotIds.length === 2)!;
    const confirmed = makeProduct(bundleConfirmation, {
      productId: "bundle-confirmed",
      name: "AMD Ryzen 5 7500F 搭 微星 B650M MORTAR WIFI 主板 板U套装",
      price: 2_099,
    });
    const optimized = optimizeComputerRecommendationV4({
      requirements: fixture.requirements,
      blueprint: fixture.blueprint,
      queries: confirmationSchedule.queryPlan,
      products: [confirmed],
      previousState: confirmationSchedule.state,
      nowMs: 90_030,
    });

    expect(optimized.state.selectedCandidates).toHaveLength(1);
    expect(optimized.state.selectedCandidates[0]?.coveredSlotIds)
      .toEqual(["slot-cpu", "slot-motherboard"]);
    expect(optimized.state.coverage.pricing.verified).toBe(2);
    expect(optimized.state.selectedSubtotal).toBe(2_099);
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
    expect((markdown.match(/联盟推广商品池未命中/g) ?? [])).toHaveLength(8);
    for (const label of ["处理器", "散热器", "主板", "内存", "显卡", "存储", "电源", "机箱"]) {
      expect(markdown).toContain(`| ${label} |`);
    }
    expect(markdown).toContain("本轮联盟推广商品核验覆盖：0/8");
    expect(markdown).toContain("技术蓝图仍完整保留");
    expect(markdown).not.toContain("待实时核价");
    expectNoUserVerificationHandoff(markdown);
  });

  it("attributes empty pricing coverage to the alliance source instead of the user", () => {
    const fixture = makeFullBuild();
    const assembled = assembleComputerReportV4({
      requirements: fixture.requirements,
      blueprint: fixture.blueprint,
      state: {
        ...fixture.state,
        stopReason: "attempts_exhausted",
        diagnostics: {
          ...fixture.state.diagnostics,
          telemetry: [
            { keyword: "14600K", provider: "pdd", providerRawCount: 0, structurallyValidCount: 0, rejectedByCategory: 0, rejectedByModel: 0, rejectedByPrice: 0, acceptedCount: 0 },
            { keyword: "sn580 1tb", provider: "pdd", providerRawCount: 15, structurallyValidCount: 15, rejectedByCategory: 15, rejectedByModel: 0, rejectedByPrice: 0, acceptedCount: 0 },
          ],
        },
      },
      products: [],
    });

    expect(assembled.report.markdown).toContain("供给源诊断：拼多多多多进宝推广商品池共执行 2 次查询");
    expect(assembled.report.markdown).toContain("该接口不代表商城全站库存");
    expect(assembled.report.markdown).toContain("当前缺口来自推广商品池，不转交用户核价");
  });

  it("shows cited public market prices separately from missing affiliate prices", () => {
    const fixture = makeFullBuild();
    const cpu = fixture.blueprint.slots.find((slot) => slot.partType === "cpu")!;
    const assembled = assembleComputerReportV4({
      requirements: fixture.requirements,
      blueprint: fixture.blueprint,
      state: fixture.state,
      products: [],
      marketEvidence: [{
        slotId: cpu.slotId,
        partType: "cpu",
        model: cpu.primaryModel,
        query: `${cpu.primaryModel} 处理器 价格`,
        minPrice: 999,
        medianPrice: 1049,
        maxPrice: 1099,
        confidence: "multi_source",
        samples: [
          { price: 999, title: `${cpu.primaryModel} 报价`, url: "https://shop-a.example/cpu", capturedAt: "2026-08-12T12:00:00.000Z" },
          { price: 1099, title: `${cpu.primaryModel} 价格`, url: "https://shop-b.example/cpu", capturedAt: "2026-08-12T12:00:00.000Z" },
        ],
      }],
    });

    expect(assembled.report.markdown).toContain("| 公开市场参考价 | 联盟推广商品 | 推广价 |");
    expect(assembled.report.markdown).toContain("¥999–¥1,099（2 源）");
    expect(assembled.report.markdown).toContain("[来源1](https://shop-a.example/cpu)");
    expect(assembled.report.markdown).toContain("公开市场参考价覆盖：1/8");
    expect(assembled.report.markdown).toContain("联盟推广商品池未命中");
    expect(assembled.report.allowedLinks).toEqual(expect.arrayContaining([
      "https://shop-a.example/cpu",
      "https://shop-b.example/cpu",
    ]));
  });

  it("reports only the verified subtotal for partial pricing without inventing a whole-build total", () => {
    const fixture = makeFullBuild();
    const discoverySchedule = scheduleFullAttempt(fixture.blueprint, fixture.state, 4, 100_000);
    const discoveryQuery = discoverySchedule.queryPlan.queries.find((query) => query.partType === "storage")!;
    const marketSample = makeProduct(discoveryQuery, {
      productId: "market-nvme",
      name: "西部数据 WD_BLACK SN770 1TB 固态硬盘 SSD NVMe M.2 内置",
      price: 499,
    });
    const discovered = optimizeComputerRecommendationV4({
      requirements: fixture.requirements,
      blueprint: fixture.blueprint,
      queries: discoverySchedule.queryPlan,
      products: [marketSample],
      previousState: discoverySchedule.state,
      maxNoProgressWaves: 2,
      wallClockLimitMs: 120_000,
      nowMs: 100_010,
    });
    expect(discovered.state.coverage.pricing.verified).toBe(0);
    expect(discovered.state.marketDiscoveries).toHaveLength(1);
    const confirmationSchedule = scheduleComputerCommerceQueriesV4(fixture.blueprint, discovered.state, {
      maxWaveQueries: 8,
      maxTotalQueries: 40,
      maxAttemptsPerSlot: 5,
      wallClockLimitMs: 120_000,
      nowMs: 100_020,
    });
    const storageQuery = confirmationSchedule.queryPlan.queries.find((query) => query.partType === "storage")!;
    expect(storageQuery.stage).toBe("market_confirmation");
    const confirmedProduct = makeProduct(storageQuery, {
      productId: "verified-nvme",
      name: "西部数据 WD_BLACK SN770 1TB 固态硬盘 SSD NVMe M.2 内置",
      price: 499,
    });
    const optimized = optimizeComputerRecommendationV4({
      requirements: fixture.requirements,
      blueprint: fixture.blueprint,
      queries: confirmationSchedule.queryPlan,
      products: [confirmedProduct],
      previousState: confirmationSchedule.state,
      maxNoProgressWaves: 2,
      wallClockLimitMs: 120_000,
      nowMs: 100_030,
    });
    expect(optimized.state.coverage.pricing.verified).toBe(1);
    const promoted = {
      ...confirmedProduct,
      promotionUrl: "https://mobile.yangkeduo.com/promotion/verified-nvme",
    };
    const assembled = assembleComputerReportV4({
      requirements: fixture.requirements,
      blueprint: fixture.blueprint,
      state: optimized.state,
      products: [promoted],
    });
    const markdown = assembled.report.markdown;

    expect((markdown.match(/<!-- v4-slot:/g) ?? [])).toHaveLength(8);
    expect((markdown.match(/联盟推广商品池未命中/g) ?? [])).toHaveLength(7);
    expect(markdown).toContain("已核验商品小计");
    expect(markdown).toContain("（1/8 个目标部件）");
    expect(markdown).toContain("核价覆盖不完整，因此不推算整机总价，也不声称满足硬预算");
    expect(markdown).not.toMatch(/整机总价[：:]\s*(?:¥|￥|CNY|\d)/i);
    expect(markdown).toContain(promoted.promotionUrl);
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
      expect(attempt.answer).toBe(baseline);
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
