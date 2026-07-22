import { describe, expect, it, vi } from "vitest";
import {
  COMPUTER_CONFIG_ASSISTANT_ID,
  COMPUTER_CONFIG_ASSISTANT_VERSION,
  COMPUTER_CONFIG_SYSTEM_PROMPT,
  DEFAULT_ASSISTANT_ID,
  ensureBuiltinAssistantSkills,
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

    expect(execute).toHaveBeenCalledTimes(9);
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
      "1.0.0",
      expect.any(Number),
    ]);
  });

  it("requires compatibility checks and evidence-aware pricing", () => {
    expect(COMPUTER_CONFIG_SYSTEM_PROMPT).toContain("兼容性");
    expect(COMPUTER_CONFIG_SYSTEM_PROMPT).toContain("联网搜索");
    expect(COMPUTER_CONFIG_SYSTEM_PROMPT).toContain("不要编造来源、跑分、商品链接或优惠");
  });
});
