import { describe, expect, it } from "vitest";
import {
  buildWebSearchPlanningPrompt,
  computerHardwareFallbackSearchQueries,
  mergePlannedWebSearchResults,
  parseWebSearchPlan,
  safeFallbackSearchQuery,
} from "../src/webSearchPlanner";
import type { LocalMessage } from "../src/storage/repositories";

function message(sequence: number, role: "user" | "assistant", content: string): LocalMessage {
  return {
    id: `m${sequence}`,
    conversationId: "c1",
    sequence,
    role,
    content,
    createdAt: sequence,
  };
}

describe("web search query planning", () => {
  it("uses recent context to resolve follow-up requests and redacts credentials", () => {
    const prompt = buildWebSearchPlanningPrompt([
      message(0, "user", "BGE small 在 Android 上表现如何？"),
      message(1, "assistant", "可以使用量化 ONNX。"),
      message(2, "user", "API Key: sk-abcdefghijk"),
    ], "那 iPhone 呢，查一下最新支持情况");

    expect(prompt).toContain("BGE small 在 Android 上表现如何");
    expect(prompt).toContain("那 iPhone 呢，查一下最新支持情况");
    expect(prompt).not.toContain("sk-abcdefghijk");
  });

  it("uses a hardware-specific discovery profile before marketplace pricing", () => {
    const prompt = buildWebSearchPlanningPrompt(
      [message(0, "user", "预算 8000 元，主要玩 2K 游戏")],
      "给我配一台完整主机",
      "computer_hardware",
    );

    expect(prompt).toContain("当前桌面 CPU/平台、显卡");
    expect(prompt).toContain("完整型号");
    expect(prompt).toContain("不要搜索拼多多、京东等商城价格");
    expect(prompt).toContain("预算 8000 元");
    expect(prompt).toContain(`当前日期是 ${new Date().toISOString().slice(0, 10)}`);
  });

  it("parses, normalizes, deduplicates, bounds, and filters planned queries", () => {
    const queries = parseWebSearchPlan(`\`\`\`json
${JSON.stringify({
  queries: [
    "  BGE small iOS CoreML 2026  ",
    "BGE small iOS CoreML 2026",
    "token: secret-value",
    "Transformers.js iPhone WebAssembly support",
    "ONNX Runtime Web iOS WebKit",
    "ignored fourth query",
  ],
})}
\`\`\``);

    expect(queries).toEqual([
      "BGE small iOS CoreML 2026",
      "Transformers.js iPhone WebAssembly support",
      "ONNX Runtime Web iOS WebKit",
    ]);
  });

  it("accepts a deliberate no-search decision but rejects malformed output", () => {
    expect(parseWebSearchPlan('{"queries":[]}')).toEqual([]);
    expect(() => parseWebSearchPlan("search this")).toThrow("JSON");
  });

  it("does not send sensitive raw text through the fallback path", () => {
    expect(safeFallbackSearchQuery("Steam 上架要求 2026")).toBe("Steam 上架要求 2026");
    expect(safeFallbackSearchQuery("API Key: sk-abcdefghijk")).toBeUndefined();
  });

  it("falls back to concrete current hardware discovery queries", () => {
    expect(computerHardwareFallbackSearchQueries("预算 8000 元玩 2K 游戏", 2026)).toEqual([
      "预算 8000 元玩 2K 游戏 2026 CPU 显卡 具体型号 评测",
      "2026 AMD Intel 桌面处理器 当前型号 官方规格",
      "2026 NVIDIA AMD Intel 桌面显卡 当前型号 2K 评测",
    ]);
    expect(computerHardwareFallbackSearchQueries("API Key: sk-abcdefghijk", 2026)[0])
      .toBe("2026 AMD Intel 桌面处理器 当前型号 官方规格");
  });

  it("round-robins multiple result groups and removes duplicate URLs", () => {
    const merged = mergePlannedWebSearchResults([
      [
        { title: "A1", url: "https://a.test/1", content: "" },
        { title: "Shared", url: "https://shared.test/", content: "" },
      ],
      [
        { title: "B1", url: "https://b.test/1", content: "" },
        { title: "Shared", url: "https://shared.test/", content: "" },
        { title: "B2", url: "https://b.test/2", content: "" },
      ],
    ], 4);

    expect(merged.map((item) => item.title)).toEqual(["A1", "B1", "Shared", "B2"]);
  });
});
