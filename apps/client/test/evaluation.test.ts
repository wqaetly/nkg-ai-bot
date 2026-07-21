import { describe, expect, it } from "vitest";
import { nextPatchVersion, scoreOutput } from "../src/evaluation";

describe("deterministic local evaluation", () => {
  it("scores required, forbidden, length and reference assertions without an LLM judge", () => {
    const result = scoreOutput("用户喜欢蓝色，并且不吃香菜。", {
      mustContain: ["蓝色"],
      mustNotContain: ["红色"],
      maxLength: 40,
      referenceAnswer: "用户喜欢蓝色，不吃香菜",
    });

    expect(result.assertions).toHaveLength(4);
    expect(result.assertions.every((item) => item.passed)).toBe(true);
    expect(result.score).toBeGreaterThan(0.8);
  });

  it("makes regressions visible as a lower deterministic score", () => {
    const assertions = { mustContain: ["TypeScript"], mustNotContain: ["删除文件"] };
    expect(scoreOutput("项目使用 TypeScript", assertions).score).toBe(1);
    expect(scoreOutput("请删除文件", assertions).score).toBe(0);
  });

  it("creates a new immutable patch version", () => {
    expect(nextPatchVersion("1.4.9")).toBe("1.4.10");
    expect(nextPatchVersion("2.0.0-beta.1")).toBe("2.0.1");
    expect(() => nextPatchVersion("latest")).toThrow("语义化版本");
  });
});
