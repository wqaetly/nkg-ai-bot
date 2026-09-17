import type { FlowInvokeOptions } from "@nkg-ai-bot/runtime-router";
import type { ProviderProfile } from "./storage/database";
import type { ApiKeyVault } from "./storage/secretVault";

export const PROVIDER_ENV_KEYS = {
  baseUrl: "LLM_BASE_URL",
  model: "LLM_DEFAULT_MODEL",
  apiKey: "LLM_API_KEY",
  structuredReasoningEffort: "LLM_STRUCTURED_REASONING_EFFORT",
  structuredThinkingMode: "LLM_STRUCTURED_THINKING_MODE",
} as const;

/** Reasoning models default to deep thinking; planners only need a small,
 * schema-constrained classification pass before deterministic policy runs. */
export function defaultStructuredReasoningEffort(model: string): "low" | undefined {
  const normalized = model.trim();
  return /^gemini-3(?:[.-]|$)/i.test(normalized)
    ? "low"
    : undefined;
}

/** DeepSeek V4 maps low/medium effort back to high. JSON planners instead
 * disable thinking so `content` receives the output budget deterministically. */
export function defaultStructuredThinkingMode(model: string): "disabled" | undefined {
  return /^deepseek-v4(?:[-.]|$)/i.test(model.trim()) ? "disabled" : undefined;
}

/**
 * Resolves the API key at the last possible moment. The returned object is
 * intended to be serialized directly into one Runtime request and discarded.
 */
export async function withProviderEnvironment(
  profile: ProviderProfile,
  vault: Pick<ApiKeyVault, "getApiKey">,
  options: FlowInvokeOptions = {},
  model = profile.defaultModel,
): Promise<FlowInvokeOptions> {
  const apiKey = await vault.getApiKey(profile.apiKeyRef);
  if (!apiKey) throw new Error(`Provider “${profile.name}” has no API Key in the local vault`);
  const reasoningEffort = defaultStructuredReasoningEffort(model);
  const thinkingMode = defaultStructuredThinkingMode(model);

  return {
    ...options,
    envOverrides: {
      variables: {
        ...(reasoningEffort
          ? { [PROVIDER_ENV_KEYS.structuredReasoningEffort]: reasoningEffort }
          : {}),
        ...(thinkingMode
          ? { [PROVIDER_ENV_KEYS.structuredThinkingMode]: thinkingMode }
          : {}),
        ...options.envOverrides?.variables,
        [PROVIDER_ENV_KEYS.baseUrl]: profile.baseUrl,
        [PROVIDER_ENV_KEYS.model]: model,
      },
      secrets: {
        ...options.envOverrides?.secrets,
        [PROVIDER_ENV_KEYS.apiKey]: apiKey,
      },
    },
  };
}
