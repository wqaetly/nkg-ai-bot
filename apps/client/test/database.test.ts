import { describe, expect, it } from "vitest";
import {
  normalizeAffiliateCommerceConfig,
  normalizeLocalMemoryConfig,
  normalizeMemoryServiceConfig,
  normalizeProviderProfile,
  normalizeWebSearchConfig,
} from "../src/storage/database";

describe("memory service configuration normalization", () => {
  it("normalizes MemOS public metadata without accepting a raw key", () => {
    expect(normalizeMemoryServiceConfig({
      provider: "memos",
      baseUrl: "https://memory.example.test/api/openmem/v1/",
      userId: " user-42 ",
      apiKeyRef: " memory:memos:api-key ",
      enabled: true,
    })).toEqual({
      provider: "memos",
      baseUrl: "https://memory.example.test/api/openmem/v1",
      userId: "user-42",
      apiKeyRef: "memory:memos:api-key",
      enabled: true,
    });
  });

  it.each([
    "file:///tmp/memory",
    "https://user:password@memory.example.test/v1",
    "https://memory.example.test/v1?token=secret",
  ])("rejects an unsafe MemOS endpoint %s", (baseUrl) => {
    expect(() => normalizeMemoryServiceConfig({
      provider: "memos",
      baseUrl,
      userId: "user-42",
      apiKeyRef: "memory:memos:api-key",
      enabled: true,
    })).toThrow();
  });
});

describe("local memory configuration normalization", () => {
  it("enables per-turn automatic archiving for existing configurations", () => {
    expect(normalizeLocalMemoryConfig({
      provider: "local",
      enabled: true,
      semanticSearch: false,
      embeddingMode: "local",
      embeddingProviderId: "",
      embeddingModel: "",
    } as Parameters<typeof normalizeLocalMemoryConfig>[0])).toMatchObject({
      autoArchive: true,
    });
  });

  it("enables the bundled local Chinese embedding model without requiring a service", () => {
    expect(normalizeLocalMemoryConfig({
      provider: "local",
      enabled: true,
      autoArchive: true,
      semanticSearch: true,
      embeddingMode: "local",
      embeddingProviderId: "",
      embeddingModel: "",
    })).toEqual({
      provider: "local",
      enabled: true,
      autoArchive: true,
      semanticSearch: true,
      embeddingMode: "local",
      embeddingProviderId: "",
      embeddingModel: "Xenova/bge-small-zh-v1.5",
    });
  });

  it("requires an explicit provider and model only for cloud semantic retrieval", () => {
    expect(() => normalizeLocalMemoryConfig({
      provider: "local",
      enabled: true,
      autoArchive: true,
      semanticSearch: true,
      embeddingMode: "cloud",
      embeddingProviderId: "",
      embeddingModel: "",
    })).toThrow("Embedding Provider");
  });
});

describe("provider profile normalization", () => {
  it("normalizes a valid custom endpoint without weakening its scheme", () => {
    expect(normalizeProviderProfile({
      id: " local ", name: " Ollama ", baseUrl: "http://192.168.1.8:11434/v1/",
      defaultModel: " qwen3 ", enabledModels: [" qwen3 ", "qwen3", "qwen3:8b"], apiKeyRef: " provider:local:api-key ",
    })).toEqual({
      id: "local", name: "Ollama", baseUrl: "http://192.168.1.8:11434/v1",
      defaultModel: "qwen3", enabledModels: ["qwen3", "qwen3:8b"],
      modelContextWindows: { qwen3: 128_000, "qwen3:8b": 128_000 },
      apiKeyRef: "provider:local:api-key",
    });
  });

  it("keeps valid per-model context windows and drops unknown or invalid entries", () => {
    const profile = normalizeProviderProfile({
      id: "p",
      name: "P",
      baseUrl: "https://example.test/v1",
      defaultModel: "model-a",
      enabledModels: ["model-a", "model-b"],
      modelContextWindows: {
        "model-a": 128_000,
        "model-b": 200_000.9,
        disabled: 64_000,
        invalid: 100,
      },
      apiKeyRef: "key",
    });

    expect(profile.modelContextWindows).toEqual({
      "model-a": 128_000,
      "model-b": 200_000,
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
      authMode: "x-api-key",
      enabled: true,
    })).toEqual({
      provider: "searxng",
      baseUrl: "https://search.example.test",
      apiKeyRef: "search:searxng:api-key",
      authMode: "x-api-key",
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
      authMode: "none",
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

  it("stores only PDD OAuth secret references and normalized expirations", () => {
    const config = normalizeAffiliateCommerceConfig({
      enabled: true,
      selectedProvider: "pdd",
      pdd: {
        clientIdRef: " commerce:pdd:client-id ",
        clientSecretRef: " commerce:pdd:client-secret ",
        accessTokenRef: " commerce:pdd:access-token ",
        refreshTokenRef: " commerce:pdd:refresh-token ",
        accessTokenExpiresAt: "2026-08-11T00:00:00+08:00",
        pid: " 100_200 ",
      },
    });

    expect(config).toEqual({
      enabled: true,
      selectedProvider: "pdd",
      pdd: {
        clientIdRef: "commerce:pdd:client-id",
        clientSecretRef: "commerce:pdd:client-secret",
        accessTokenRef: "commerce:pdd:access-token",
        refreshTokenRef: "commerce:pdd:refresh-token",
        accessTokenExpiresAt: "2026-08-10T16:00:00.000Z",
        pid: "100_200",
      },
    });
    expect(JSON.stringify(config)).not.toContain("access-token-value");
  });
});
