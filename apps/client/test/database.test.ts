import { describe, expect, it } from "vitest";
import {
  normalizeAffiliateCommerceConfig,
  normalizeProviderProfile,
  normalizeWebSearchConfig,
} from "../src/storage/database";

describe("provider profile normalization", () => {
  it("normalizes a valid custom endpoint without weakening its scheme", () => {
    expect(normalizeProviderProfile({
      id: " local ", name: " Ollama ", baseUrl: "http://192.168.1.8:11434/v1/",
      defaultModel: " qwen3 ", enabledModels: [" qwen3 ", "qwen3", "qwen3:8b"], apiKeyRef: " provider:local:api-key ",
    })).toEqual({
      id: "local", name: "Ollama", baseUrl: "http://192.168.1.8:11434/v1",
      defaultModel: "qwen3", enabledModels: ["qwen3", "qwen3:8b"], apiKeyRef: "provider:local:api-key",
    });
  });

  it.each([
    "file:///tmp/provider",
    "https://user:password@example.test/v1",
    "https://example.test/v1?token=secret",
  ])("rejects unsafe or ambiguous endpoint %s", (baseUrl) => {
    expect(() => normalizeProviderProfile({
      id: "p", name: "P", baseUrl, defaultModel: "m", enabledModels: ["m"], apiKeyRef: "key",
    })).toThrow();
  });
});

describe("web search configuration normalization", () => {
  it("normalizes a SearXNG endpoint without storing credentials", () => {
    expect(normalizeWebSearchConfig({
      provider: "searxng",
      baseUrl: "https://search.example.test/",
      apiKeyRef: " search:searxng:api-key ",
      enabled: true,
    })).toEqual({
      provider: "searxng",
      baseUrl: "https://search.example.test",
      apiKeyRef: "search:searxng:api-key",
      enabled: true,
    });
  });

  it.each([
    "file:///tmp/search",
    "https://user:password@search.example.test",
    "https://search.example.test?key=secret",
  ])("rejects unsafe SearXNG endpoint %s", (baseUrl) => {
    expect(() => normalizeWebSearchConfig({
      provider: "searxng",
      baseUrl,
      apiKeyRef: "search:searxng:api-key",
      enabled: true,
    })).toThrow();
  });
});

describe("affiliate commerce configuration normalization", () => {
  it("normalizes public metadata and secret references without accepting raw credentials", () => {
    const config = normalizeAffiliateCommerceConfig({
      enabled: true,
      selectedProvider: "jd",
      jd: {
        appKeyRef: " commerce:jd:app-key ",
        secretKeyRef: " commerce:jd:secret-key ",
        pid: " 100:200:300 ",
        siteId: " 12345 ",
        positionId: " 67890 ",
      },
    });

    expect(config).toEqual({
      enabled: true,
      selectedProvider: "jd",
      jd: {
        appKeyRef: "commerce:jd:app-key",
        secretKeyRef: "commerce:jd:secret-key",
        pid: "100:200:300",
        siteId: "12345",
        positionId: "67890",
      },
    });
    expect(JSON.stringify(config)).not.toContain("secret-value");
  });

  it("rejects invalid platform metadata and enabled incomplete configurations", () => {
    expect(() => normalizeAffiliateCommerceConfig({
      enabled: true,
      selectedProvider: "jd",
    })).toThrow("京东联盟配置不完整");
    expect(() => normalizeAffiliateCommerceConfig({
      enabled: true,
      selectedProvider: "jd",
      jd: {
        appKeyRef: "commerce:jd:app-key",
        secretKeyRef: "commerce:jd:secret-key",
        pid: "100:200:300",
        siteId: "not-a-number",
        positionId: "67890",
      },
    })).toThrow("必须为数字");
  });
});
