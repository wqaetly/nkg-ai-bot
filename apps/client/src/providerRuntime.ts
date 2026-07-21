import type { FlowInvokeOptions } from "@nkg-ai-bot/runtime-router";
import type { ProviderProfile } from "./storage/database";
import type { ApiKeyVault } from "./storage/secretVault";

export const PROVIDER_ENV_KEYS = {
  baseUrl: "LLM_BASE_URL",
  model: "LLM_DEFAULT_MODEL",
  apiKey: "LLM_API_KEY",
} as const;

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

  return {
    ...options,
    envOverrides: {
      variables: {
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
