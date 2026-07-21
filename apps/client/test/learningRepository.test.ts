import { describe, expect, it } from "vitest";
import {
  normalizeMemoryContent,
  rankMemoryItems,
  type MemoryItem,
} from "../src/learningRepository";

function memory(id: string, content: string, updatedAt = 1): MemoryItem {
  return {
    id,
    namespace: "global",
    content,
    confidence: 1,
    status: "active",
    createdAt: 1,
    updatedAt,
  };
}

describe("local learning memory", () => {
  it("ranks relevant Chinese facts without sending the memory index elsewhere", () => {
    const ranked = rankMemoryItems("我喜欢什么颜色？", [
      memory("timezone", "用户居住在上海，时区为北京时间", 3),
      memory("color", "用户喜欢蓝色", 2),
      memory("food", "用户不吃香菜", 1),
    ]);

    expect(ranked.map((item) => item.id)).toEqual(["color"]);
  });

  it("uses recency as the deterministic tie breaker", () => {
    const ranked = rankMemoryItems("项目使用 TypeScript", [
      memory("old", "旧项目使用 TypeScript", 1),
      memory("new", "当前项目使用 TypeScript", 2),
    ]);

    expect(ranked.map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("normalizes whitespace and rejects empty or oversized facts", () => {
    expect(normalizeMemoryContent("  用户\n喜欢  蓝色  ")).toBe("用户 喜欢 蓝色");
    expect(() => normalizeMemoryContent("   ")).toThrow("记忆内容不能为空");
    expect(() => normalizeMemoryContent("a".repeat(1_001))).toThrow("1000");
  });
});
