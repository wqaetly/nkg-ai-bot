import { describe, expect, it } from "vitest";
import {
  buildContextCompressionPrompt,
  estimateTextTokens,
  getContextBudget,
  shouldCompressContext,
  splitMessagesForCompression,
  truncateSummaryToTokenBudget,
} from "../src/contextCompression";
import type { LocalMessage } from "../src/storage/repositories";

function message(sequence: number, role: LocalMessage["role"], content: string): LocalMessage {
  return {
    id: `m${sequence}`,
    conversationId: "c1",
    sequence,
    role,
    content,
    createdAt: sequence,
  };
}

describe("context compression budget", () => {
  it("uses the LobeHub-style 50% threshold with a 1.25x drift reserve", () => {
    const budget = getContextBudget(128_000);
    expect(budget).toEqual({
      contextWindowTokens: 128_000,
      thresholdTokens: 64_000,
      rawInputBudgetTokens: 51_200,
    });
    expect(shouldCompressContext(51_200, budget)).toBe(false);
    expect(shouldCompressContext(51_201, budget)).toBe(true);
  });

  it("estimates CJK more conservatively than ASCII prose", () => {
    expect(estimateTextTokens("你".repeat(100))).toBeGreaterThan(
      estimateTextTokens("a".repeat(100)),
    );
  });

  it("keeps a bounded recent tail and always preserves the trailing user message", () => {
    const messages = [
      message(0, "user", "旧问题".repeat(300)),
      message(1, "assistant", "旧回答".repeat(300)),
      message(2, "user", "当前问题"),
    ];
    const split = splitMessagesForCompression(messages, 100);
    expect(split.messagesToCompress.map((item) => item.sequence)).toEqual([0, 1]);
    expect(split.recentMessages.map((item) => item.sequence)).toEqual([2]);
  });

  it("builds an incremental structured summary prompt and can cap an oversized summary", () => {
    const prompt = buildContextCompressionPrompt(
      [message(2, "user", "新增要求")],
      "既有决定：使用 SQLite",
    );
    expect(prompt).toContain("<existing_summary>");
    expect(prompt).toContain("既有决定：使用 SQLite");
    expect(prompt).toContain("新增要求");
    expect(prompt).toContain("### 决策与结论");

    const truncated = truncateSummaryToTokenBudget("摘要".repeat(2_000), 100);
    expect(estimateTextTokens(truncated)).toBeLessThanOrEqual(100);
    expect(truncated).toContain("较早摘要已裁剪");
  });
});
