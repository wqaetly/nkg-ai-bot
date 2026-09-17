import { describe, expect, it } from "vitest";
import {
  flowConfigurableVariables,
  normalizeConversationFlowVariables,
  parseConversationFlowVariables,
} from "../src/conversationFlowConfig";

const graph = {
  configurableVariables: [
    {
      name: "LLM_FLOW_MAX_OUTPUT_TOKENS",
      label: "最大输出 Token",
      type: "select",
      defaultValue: 6144,
      options: [
        { label: "6K", value: 6144 },
        { label: "16K", value: 16384 },
      ],
    },
    {
      name: "ANSWER_TEMPERATURE",
      label: "回答温度",
      type: "number",
      defaultValue: 0.2,
      min: 0,
      max: 2,
      step: 0.1,
    },
    {
      name: "INCLUDE_DETAILS",
      label: "包含详情",
      type: "boolean",
      defaultValue: true,
    },
  ],
};

describe("conversation Flow configuration", () => {
  it("reads generic Flow-owned variable declarations", () => {
    expect(flowConfigurableVariables(graph)).toEqual(graph.configurableVariables);
  });

  it("keeps only values exposed by the current Flow and inside their domains", () => {
    const definitions = flowConfigurableVariables(graph);
    expect(normalizeConversationFlowVariables(definitions, {
      LLM_FLOW_MAX_OUTPUT_TOKENS: 16384,
      ANSWER_TEMPERATURE: 0.7,
      INCLUDE_DETAILS: false,
      UNKNOWN_SETTING: "ignored",
    })).toEqual({
      LLM_FLOW_MAX_OUTPUT_TOKENS: 16384,
      ANSWER_TEMPERATURE: 0.7,
      INCLUDE_DETAILS: false,
    });
    expect(normalizeConversationFlowVariables(definitions, {
      LLM_FLOW_MAX_OUTPUT_TOKENS: 9999,
      ANSWER_TEMPERATURE: 5,
      INCLUDE_DETAILS: "false",
    })).toEqual({});
  });

  it("never exposes provider credentials or secret-like environment variables", () => {
    expect(flowConfigurableVariables({ configurableVariables: [
      { name: "LLM_API_KEY", label: "API Key", type: "string" },
      { name: "SERVICE_ACCESS_TOKEN", label: "Token", type: "string" },
      { name: "SAFE_MODE", label: "安全模式", type: "boolean", defaultValue: true },
    ] })).toEqual([
      expect.objectContaining({ name: "SAFE_MODE" }),
    ]);
  });

  it("parses only primitive environment variable values from conversation storage", () => {
    expect(parseConversationFlowVariables({
      NUMBER: 1,
      TEXT: "value",
      FLAG: true,
      NULL_VALUE: null,
      OBJECT: { nested: true },
      "bad-name": "ignored",
    })).toEqual({ NUMBER: 1, TEXT: "value", FLAG: true });
  });
});
