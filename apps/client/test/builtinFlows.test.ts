import { describe, expect, it, vi } from "vitest";
import { validateFlow } from "@ai-native-flow/flow-validator";
import {
  BUILTIN_CHAT_FLOW,
  BUILTIN_CHAT_FLOW_ID,
  BUILTIN_CHAT_FLOW_VERSION,
  BUILTIN_REFLECTION_FLOW,
  BUILTIN_REFLECTION_FLOW_ID,
  BUILTIN_REFLECTION_FLOW_VERSION,
  BUILTIN_WEB_SEARCH_PLANNER_FLOW,
  BUILTIN_WEB_SEARCH_PLANNER_FLOW_ID,
  BUILTIN_WEB_SEARCH_PLANNER_FLOW_VERSION,
  COMPUTER_CONFIG_FLOW,
  COMPUTER_CONFIG_FLOW_ID,
  COMPUTER_CONFIG_FLOW_VERSION,
  ensureBuiltinFlows,
} from "../src/builtinFlows";
import { FLOW_MAX_OUTPUT_TOKENS_VARIABLE } from "../src/conversationFlowConfig";

describe("built-in Flow catalog", () => {
  it("seeds the chat Flow when missing and never embeds a provider secret", async () => {
    const upsert = vi.fn(async () => undefined);
    const created = await ensureBuiltinFlows({ list: async () => [], upsert });

    expect(created).toBe(4);
    expect(upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: BUILTIN_CHAT_FLOW_ID,
      version: BUILTIN_CHAT_FLOW_VERSION,
      graph: BUILTIN_CHAT_FLOW,
    }));
    expect(upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: BUILTIN_WEB_SEARCH_PLANNER_FLOW_ID,
      version: BUILTIN_WEB_SEARCH_PLANNER_FLOW_VERSION,
      graph: BUILTIN_WEB_SEARCH_PLANNER_FLOW,
    }));
    expect(upsert).toHaveBeenNthCalledWith(3, expect.objectContaining({
      id: COMPUTER_CONFIG_FLOW_ID,
      version: COMPUTER_CONFIG_FLOW_VERSION,
      graph: COMPUTER_CONFIG_FLOW,
    }));
    expect(upsert).toHaveBeenNthCalledWith(4, expect.objectContaining({
      id: BUILTIN_REFLECTION_FLOW_ID,
      version: BUILTIN_REFLECTION_FLOW_VERSION,
      graph: BUILTIN_REFLECTION_FLOW,
    }));
    const serialized = JSON.stringify([
      BUILTIN_CHAT_FLOW,
      BUILTIN_WEB_SEARCH_PLANNER_FLOW,
      COMPUTER_CONFIG_FLOW,
      BUILTIN_REFLECTION_FLOW,
    ]);
    expect(serialized).toContain("$var:LLM_API_KEY");
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(validateFlow(COMPUTER_CONFIG_FLOW).result.ok).toBe(true);
    expect(validateFlow(BUILTIN_WEB_SEARCH_PLANNER_FLOW).result.ok).toBe(true);
    expect(BUILTIN_WEB_SEARCH_PLANNER_FLOW.nodes.find((node) => node.id === "search_query_planner"))
      .toMatchObject({ config: { stream: false, maxTokens: 500, runtimeTimeoutMs: 45000 } });
    expect(BUILTIN_CHAT_FLOW.nodes.find((node) => node.id === "chat_model"))
      .toMatchObject({ config: {
        maxTokens: 4096,
        maxTokensVariable: `$var:${FLOW_MAX_OUTPUT_TOKENS_VARIABLE}`,
      } });
    expect(BUILTIN_CHAT_FLOW.configurableVariables).toEqual([
      expect.objectContaining({
        name: FLOW_MAX_OUTPUT_TOKENS_VARIABLE,
        type: "select",
        defaultValue: 4096,
      }),
    ]);
    const computerNodeIds = COMPUTER_CONFIG_FLOW.nodes.map((node) => node.id);
    expect(COMPUTER_CONFIG_FLOW_VERSION).toBe("4.7.2");
    expect(computerNodeIds).toEqual(expect.arrayContaining([
      "requirement_policy_v2",
      "blueprint_guard",
      "revision_search",
      "revision_planner",
      "revision_guard",
      "commerce_loop_begin",
      "query_scheduler_loop",
      "product_search_loop",
      "optimizer_v2_loop",
      "commerce_loop_end",
      "selection_merge",
      "product_links",
      "commerce_report_assembler",
      "commerce_report_guard",
      "final_answer_merge",
      "end",
    ]));
    expect(computerNodeIds).not.toContain("chat_model");
    expect(COMPUTER_CONFIG_FLOW.nodes.filter((node) => node.type === "commerce_query_scheduler"))
      .toHaveLength(1);
    expect(COMPUTER_CONFIG_FLOW.nodes.filter((node) => node.type === "computer_recommendation_optimizer_v2"))
      .toHaveLength(1);
    expect(COMPUTER_CONFIG_FLOW.nodes.filter((node) => node.type === "browser_commerce"))
      .toHaveLength(1);
    expect(COMPUTER_CONFIG_FLOW.nodes.filter((node) => node.type === "public_market_search"))
      .toHaveLength(0);
    expect(COMPUTER_CONFIG_FLOW.nodes.find((node) => node.id === "product_search_loop"))
      .toMatchObject({
        type: "browser_commerce",
        config: { maxQueries: 1 },
      });
    expect(COMPUTER_CONFIG_FLOW.nodes.find((node) => node.id === "query_scheduler_loop"))
      .toMatchObject({
        type: "commerce_query_scheduler",
        config: { maxWaveQueries: 1, maxTotalQueries: 32, maxAttemptsPerSlot: 3 },
      });
    expect(COMPUTER_CONFIG_FLOW.nodes.find((node) => node.id === "requirement_planner"))
      .toMatchObject({ config: {
        jsonOutput: true,
        reasoningEffort: "$var:LLM_STRUCTURED_REASONING_EFFORT",
        thinkingMode: "$var:LLM_STRUCTURED_THINKING_MODE",
        maxTokens: 2200,
        runtimeTimeoutMs: 120000,
      } });
    expect(COMPUTER_CONFIG_FLOW.nodes.find((node) => node.id === "commerce_loop_begin"))
      .toMatchObject({ type: "loop_begin", config: { maxIterations: 32, timeoutMs: 480000 } });
    expect(COMPUTER_CONFIG_FLOW.nodes.find((node) => node.id === "commerce_loop_end"))
      .toMatchObject({ type: "loop_end", config: { condition: "nextState.continue == true" } });
    expect(COMPUTER_CONFIG_FLOW.nodes.find((node) => node.id === "direct_model"))
      .toMatchObject({ config: {
        maxTokens: 4096,
        maxTokensVariable: `$var:${FLOW_MAX_OUTPUT_TOKENS_VARIABLE}`,
        stream: false,
      } });
    expect(JSON.stringify(COMPUTER_CONFIG_FLOW)).not.toMatch(/"(?:minPrice|maxPrice|targetPrice)"/);
    expect(COMPUTER_CONFIG_FLOW.configurableVariables).toEqual([
      expect.objectContaining({
        name: FLOW_MAX_OUTPUT_TOKENS_VARIABLE,
        type: "select",
        defaultValue: 6144,
        options: expect.arrayContaining([
          expect.objectContaining({ value: 16384 }),
          expect.objectContaining({ value: 32000 }),
        ]),
      }),
      expect.objectContaining({ name: "COMPUTER_SHOPPING_PLATFORM", type: "select", options: [
        { label: "拼多多", value: "pdd" }, { label: "京东", value: "jd" }, { label: "淘宝", value: "taobao" },
      ] }),
    ]);
  });

  it("preserves an existing locally edited built-in Flow", async () => {
    const upsert = vi.fn(async () => undefined);
    const created = await ensureBuiltinFlows({
      list: async () => [
        {
          id: BUILTIN_CHAT_FLOW_ID,
          version: BUILTIN_CHAT_FLOW_VERSION,
          name: "用户修改版",
          graph: { id: BUILTIN_CHAT_FLOW_ID, version: BUILTIN_CHAT_FLOW_VERSION },
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: BUILTIN_WEB_SEARCH_PLANNER_FLOW_ID,
          version: BUILTIN_WEB_SEARCH_PLANNER_FLOW_VERSION,
          name: "用户修改版搜索规划",
          graph: { id: BUILTIN_WEB_SEARCH_PLANNER_FLOW_ID, version: BUILTIN_WEB_SEARCH_PLANNER_FLOW_VERSION },
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: COMPUTER_CONFIG_FLOW_ID,
          version: COMPUTER_CONFIG_FLOW_VERSION,
          name: "用户修改版电脑顾问",
          graph: { id: COMPUTER_CONFIG_FLOW_ID, version: COMPUTER_CONFIG_FLOW_VERSION },
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: BUILTIN_REFLECTION_FLOW_ID,
          version: BUILTIN_REFLECTION_FLOW_VERSION,
          name: "用户修改版反思",
          graph: { id: BUILTIN_REFLECTION_FLOW_ID, version: BUILTIN_REFLECTION_FLOW_VERSION },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      upsert,
    });

    expect(created).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });
});
