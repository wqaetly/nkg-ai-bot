import { describe, expect, it } from "vitest";
import {
  PROVIDER_ENV_KEYS,
  defaultStructuredReasoningEffort,
  defaultStructuredThinkingMode,
  withProviderEnvironment,
} from "../src/providerRuntime";
import type { ProviderProfile } from "../src/storage/database";

const profile: ProviderProfile = {
  id: "provider-1",
  name: "Local model",
  baseUrl: "http://127.0.0.1:11434/v1",
  defaultModel: "qwen3",
  enabledModels: ["qwen3", "qwen3:8b"],
  apiKeyRef: "provider:provider-1:api-key",
  createdAt: 1,
  updatedAt: 1,
};

describe("provider Runtime environment", () => {
  it("resolves the key only into run-scoped secrets", async () => {
    const options = await withProviderEnvironment(
      profile,
      { getApiKey: async () => "local-secret" },
      {
        traceId: "trace-1",
        envOverrides: {
          variables: { CUSTOM: "value", LLM_BASE_URL: "replaced" },
          secrets: { CUSTOM_SECRET: "kept" },
        },
      },
    );

    expect(options).toEqual({
      traceId: "trace-1",
      envOverrides: {
        variables: {
          CUSTOM: "value",
          LLM_BASE_URL: profile.baseUrl,
          LLM_DEFAULT_MODEL: profile.defaultModel,
        },
        secrets: {
          CUSTOM_SECRET: "kept",
          LLM_API_KEY: "local-secret",
        },
      },
    });
    expect(Object.values(options.envOverrides?.variables ?? {})).not.toContain("local-secret");
  });

  it("fails before invoking a Flow when the vault has no key", async () => {
    await expect(withProviderEnvironment(
      profile,
      { getApiKey: async () => undefined },
    )).rejects.toThrow("has no API Key");
  });

  it("uses model-compatible structured planner controls", async () => {
    expect(defaultStructuredReasoningEffort("gemini-3.1-pro-preview")).toBe("low");
    expect(defaultStructuredReasoningEffort("deepseek-v4-flash")).toBeUndefined();
    expect(defaultStructuredReasoningEffort("qwen3")).toBeUndefined();
    expect(defaultStructuredThinkingMode("deepseek-v4-flash")).toBe("disabled");
    expect(defaultStructuredThinkingMode("deepseek-v4-pro")).toBe("disabled");
    expect(defaultStructuredThinkingMode("gemini-3.1-pro-preview")).toBeUndefined();

    const options = await withProviderEnvironment(
      { ...profile, defaultModel: "deepseek-v4-flash", enabledModels: ["deepseek-v4-flash"] },
      { getApiKey: async () => "local-secret" },
    );

    expect(options.envOverrides?.variables).toMatchObject({
      [PROVIDER_ENV_KEYS.structuredThinkingMode]: "disabled",
    });
    expect(options.envOverrides?.variables).not.toHaveProperty(
      PROVIDER_ENV_KEYS.structuredReasoningEffort,
    );
  });
});
