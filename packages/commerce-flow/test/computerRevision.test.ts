import { describe, expect, it } from "vitest";
import { matchesCommerceIdentity, hasAmbiguousModelPrice } from "../src/browserCommerce";
import { applyComputerRevision, prepareComputerRevision } from "../src/computerRevision";
import {
  guardComputerBlueprintV4, normalizeComputerRequirementV4, makeComputerQuery,
  verifyComputerCandidateV4, scheduleComputerCommerceQueriesV4, optimizeComputerRecommendationV4,
} from "../src/computerAdvisorV4";

function cpuState() {
  const requirements = normalizeComputerRequirementV4({ intent: "parts", targetParts: ["cpu"],
    budget: { amount: 1000, mode: "hard", hardCap: true, currency: "CNY" } }, "1000元推荐处理器").requirements;
  return guardComputerBlueprintV4({ slots: [{ partType: "cpu", primaryModel: "AMD Ryzen 5 7600", requiredSpecs: { socket: "AM5" } }] }, requirements).state;
}

describe("product identity and fresh revision evidence", () => {
  it("rejects the reported RX7600 listing even when query metadata says CPU", () => {
    const state = cpuState();
    const slot = state.blueprint.slots[0]!;
    const query = makeComputerQuery(slot, "exact_model", 1)!;
    const result = verifyComputerCandidateV4({ slot, query, product: {
      provider: "taobao", productId: "1074841851473", partType: "cpu", slotId: slot.slotId,
      queryId: query.queryId, name: "小影霸RX7600XT/RX7600S 8G全新台式电脑高清电竞游戏独立显卡AI",
      price: 1749, sourceKind: "browser", detailVerified: true, affiliate: false, hasCoupon: false, capturedAt: new Date().toISOString(),
    } });
    expect(result).toMatchObject({ reasons: expect.arrayContaining(["model_anchor_missing"]) });
    expect(matchesCommerceIdentity("cpu", "AMD 锐龙5 7600 处理器", ["7600"])).toBe(true);
    expect(matchesCommerceIdentity("cpu", "AMD 锐龙5 7600X 处理器", ["7600"])).toBe(false);
  });

  it("does not equate a chipset, model suffix or mixed SKU listing with an exact product", () => {
    expect(matchesCommerceIdentity("gpu", "AMD RX9060XT 8g 显卡", ["9060"])).toBe(false);
    expect(matchesCommerceIdentity("gpu", "RX 9060 8GB 显卡", ["9060"])).toBe(true);
    expect(matchesCommerceIdentity("motherboard", "技嘉 B650M 小雕主板", ["b650m"], "微星 PRO B650M-A WIFI")).toBe(false);
    expect(matchesCommerceIdentity("motherboard", "微星 PRO B650M-P 主板", ["b650m"], "微星 PRO B650M-A WIFI")).toBe(false);
    expect(hasAmbiguousModelPrice("motherboard", "技嘉 B850M AORUS ELITE AX/B650M主板")).toBe(true);
    expect(hasAmbiguousModelPrice("gpu", "AMD RX9060XT 8g/16G显卡")).toBe(true);
    expect(hasAmbiguousModelPrice("memory", "金百达32GB(16GBX2)套装DDR5 6400 C32内存6000 C30 16GAdie银爵")).toBe(true);
    expect(hasAmbiguousModelPrice("memory", "金百达32GB(16GBX2)套装DDR5 6000 C30 银爵")).toBe(false);
    expect(matchesCommerceIdentity("cpu", "Intel Core Ultra 5 245K 处理器", ["coreultra5245k"])).toBe(true);
  });

  it("authorizes an unplanned alternative only with fresh model and platform evidence", () => {
    let state = cpuState();
    const scheduled = scheduleComputerCommerceQueriesV4(state.blueprint, state, { researchEnabled: true });
    state = optimizeComputerRecommendationV4({ requirements: state.requirements, blueprint: state.blueprint,
      previousState: scheduled.state, queries: scheduled.queryPlan.queries, products: [], researchEnabled: true }).state;
    const context = prepareComputerRevision(state)!;
    expect(context.slotId).toBe("slot-cpu");
    context.results = [{ title: "AMD Ryzen 5 7500F AM5 处理器对比", content: "AM5 平台", url: "https://review.example.test/cpu" }];
    const draft = { model: "AMD Ryzen 5 7500F", sources: [context.results[0]!.url], reason: "同平台替代" };
    const revised = applyComputerRevision(context, draft);
    expect(revised.revisionNotes?.[0]).toContain(context.results[0]!.url);
    const next = scheduleComputerCommerceQueriesV4(state.blueprint, revised, { researchEnabled: true });
    expect(next.queryPlan.queries[0]?.keyword).toBe("7500F 处理器");
    expect(next.state.blueprint.slots[0]?.alternatives[0]?.model).toBe(draft.model);
    expect(next.state.candidatePool).toHaveLength(0); // Search evidence is not a priced product.
    for (const invalid of [{ ...draft, sources: ["https://invented.example/"] }, { ...draft, model: "AMD Ryzen 5 7400F" }]) {
      const rejected = applyComputerRevision(context, invalid);
      expect(rejected.scheduler.researchAttemptsBySlot["slot-cpu"]).toBe(2);
      expect(rejected.revisionNotes?.[0]).toContain("未采用");
    }
    const unsupported = applyComputerRevision({ ...context, results: [{ ...context.results[0]!, title: "7500F", content: "处理器" }] }, draft);
    expect(unsupported.revisionNotes?.[0]).toContain("兼容证据");
  });

  it("does not research after fatal, time, or query limits", () => {
    const state = cpuState();
    state.scheduler.attemptsBySlot["slot-cpu"] = 1;
    expect(prepareComputerRevision({ ...state, stopReason: "commerce_unavailable" })).toBeUndefined();
    expect(prepareComputerRevision({ ...state, scheduler: { ...state.scheduler, startedAtMs: Date.now() - 480_001 } })).toBeUndefined();
    expect(prepareComputerRevision({ ...state, scheduler: { ...state.scheduler, totalIssued: state.scheduler.maxTotalQueries } })).toBeUndefined();
  });
});
