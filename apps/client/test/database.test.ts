import { describe, expect, it } from "vitest";
import { normalizeProviderProfile } from "../src/storage/database";

describe("provider profile normalization", () => {
  it("normalizes a valid custom endpoint without weakening its scheme", () => {
    expect(normalizeProviderProfile({
      id: " local ", name: " Ollama ", baseUrl: "http://192.168.1.8:11434/v1/",
      defaultModel: " qwen3 ", apiKeyRef: " provider:local:api-key ",
    })).toEqual({
      id: "local", name: "Ollama", baseUrl: "http://192.168.1.8:11434/v1",
      defaultModel: "qwen3", apiKeyRef: "provider:local:api-key",
    });
  });

  it.each([
    "file:///tmp/provider",
    "https://user:password@example.test/v1",
    "https://example.test/v1?token=secret",
  ])("rejects unsafe or ambiguous endpoint %s", (baseUrl) => {
    expect(() => normalizeProviderProfile({
      id: "p", name: "P", baseUrl, defaultModel: "m", apiKeyRef: "key",
    })).toThrow();
  });
});
