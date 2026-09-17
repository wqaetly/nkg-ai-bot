import { describe, expect, it, vi } from "vitest";
import {
  COMPUTER_CONFIG_ASSISTANT_ID,
  COMPUTER_CONFIG_ASSISTANT_VERSION,
  COMPUTER_CONFIG_SYSTEM_PROMPT,
  DEFAULT_ASSISTANT_ID,
  DEFAULT_ASSISTANT_VERSION,
  ensureBuiltinAssistantSkills,
  filterAssistantSkillIndex,
  type AssistantSkillIndex,
} from "../src/assistantSkills";
import { COMPUTER_CONFIG_FLOW_ID, COMPUTER_CONFIG_FLOW_VERSION } from "../src/builtinFlows";
import type { DatabaseClient } from "../src/storage/database";

describe("built-in Assistant Skills", () => {
  it("seeds the general assistant and selectable computer configuration advisor", async () => {
    const execute = vi.fn(async () => ({ rowsAffected: 1 }));
    const database: DatabaseClient = {
      execute,
      select: async <T>() => [] as T,
    };

    await ensureBuiltinAssistantSkills(database);

    expect(execute).toHaveBeenCalledTimes(12);
    const argumentsByCall = execute.mock.calls.map((call) => call[1] as unknown[] | undefined);
    expect(argumentsByCall.some((args) => args?.[0] === DEFAULT_ASSISTANT_ID)).toBe(true);
    expect(argumentsByCall.some((args) => args?.[0] === COMPUTER_CONFIG_ASSISTANT_ID)).toBe(true);
    expect(argumentsByCall).toContainEqual(expect.arrayContaining([
      COMPUTER_CONFIG_ASSISTANT_ID,
      COMPUTER_CONFIG_ASSISTANT_VERSION,
      "电脑配置顾问",
      expect.any(String),
      COMPUTER_CONFIG_SYSTEM_PROMPT,
      COMPUTER_CONFIG_FLOW_ID,
      COMPUTER_CONFIG_FLOW_VERSION,
      "computer_config",
    ]));
    expect(argumentsByCall).toContainEqual([
      COMPUTER_CONFIG_ASSISTANT_ID,
      COMPUTER_CONFIG_ASSISTANT_VERSION,
      "2.0.0",
      "2.1.0",
      "3.0.0",
      "3.0.1",
      "3.0.2",
      "3.0.3",
      "3.0.4",
      "3.0.5",
      "3.0.6",
      "4.0.0",
      "4.1.0",
      "4.2.0",
      "4.2.1",
      "4.2.2",
      "4.3.0",
      "4.3.1",
      expect.any(Number),
    ]);
    expect(argumentsByCall).toContainEqual([
      DEFAULT_ASSISTANT_ID,
      DEFAULT_ASSISTANT_VERSION,
      "1.0.0",
      "1.0.1",
      expect.any(Number),
    ]);
    expect(execute.mock.calls.some((call) => (
      String(call[0]).includes("UPDATE conversations")
      && (call[1] as unknown[] | undefined)?.[0] === COMPUTER_CONFIG_ASSISTANT_ID
      && (call[1] as unknown[] | undefined)?.[1] === COMPUTER_CONFIG_ASSISTANT_VERSION
    ))).toBe(true);
  });

  it("filters assistant discovery by name, description, capabilities, and activation hints", () => {
    const baseSkill: AssistantSkillIndex = {
      assistantId: DEFAULT_ASSISTANT_ID,
      activeVersion: "1.0.0",
      name: "NKG",
      description: "通用对话助手",
      flowId: "chat",
      flowVersion: "1.0.0",
      capabilities: ["general-chat"],
      activationHints: ["日常问答"],
      pinned: false,
      archived: false,
      useCount: 0,
      successCount: 0,
      failureCount: 0,
      updatedAt: 1,
    };
    const computerSkill: AssistantSkillIndex = {
      ...baseSkill,
      assistantId: COMPUTER_CONFIG_ASSISTANT_ID,
      name: "电脑配置顾问",
      description: "装机与硬件升级建议",
      capabilities: ["product-search", "compatibility-check"],
      activationHints: ["游戏主机", "CPU 主板"],
    };
    const skills = [baseSkill, computerSkill];

    expect(filterAssistantSkillIndex(skills, "电脑")).toEqual([computerSkill]);
    expect(filterAssistantSkillIndex(skills, "硬件 升级")).toEqual([computerSkill]);
    expect(filterAssistantSkillIndex(skills, "COMPATIBILITY")).toEqual([computerSkill]);
    expect(filterAssistantSkillIndex(skills, "cpu 主板")).toEqual([computerSkill]);
    expect(filterAssistantSkillIndex(skills, "  ")).toBe(skills);
  });

  it("requires compatibility checks and evidence-aware pricing", () => {
    expect(COMPUTER_CONFIG_SYSTEM_PROMPT).toContain("兼容性");
    expect(COMPUTER_CONFIG_SYSTEM_PROMPT).toContain("联网搜索");
    expect(COMPUTER_CONFIG_SYSTEM_PROMPT).toContain("联网网页价格不得冒充核价结果");
    expect(COMPUTER_CONFIG_SYSTEM_PROMPT).toContain("不要编造来源、跑分、商品链接或优惠");
    expect(COMPUTER_CONFIG_SYSTEM_PROMPT).toContain("局部配件和升级只回答目标部件");
    expect(COMPUTER_CONFIG_SYSTEM_PROMPT).toContain("硬预算不得超出");
  });
});
