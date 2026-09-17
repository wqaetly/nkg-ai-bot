import { describe, expect, it, vi } from "vitest";
import {
  fetchCompatibleModels,
  fetchSearxngResults,
  pingCompatibleModel,
  ProviderSession,
  type ProviderDataStore,
} from "../src/providerSession";
import type {
  AffiliateCommerceConfig,
  ProviderProfile,
  ProviderProfileInput,
  LocalMemoryConfig,
  WebSearchConfig,
} from "../src/storage/database";
import type { ApiKeyVault } from "../src/storage/secretVault";
import { HostedAiClient } from "../src/hostedAi";
import { HostedAiSession } from "../src/hostedAiSession";

class MemoryVault implements ApiKeyVault {
  readonly values = new Map<string, string>();
  locked = false;
  async setApiKey(reference: string, apiKey: string) { this.values.set(reference, apiKey); }
  async getApiKey(reference: string) { return this.values.get(reference); }
  async removeApiKey(reference: string) { this.values.delete(reference); }
  async lock() { this.locked = true; }
}

class MemoryStore implements ProviderDataStore {
  readonly profiles = new Map<string, ProviderProfile>();
  webSearchConfig: WebSearchConfig | undefined;
  localMemoryConfig: LocalMemoryConfig | undefined;
  commerceConfig: AffiliateCommerceConfig | undefined;
  selectedId: string | undefined;
  failUpsert = false;
  failDelete = false;
  async list() { return [...this.profiles.values()]; }
  async upsert(input: ProviderProfileInput) {
    if (this.failUpsert) throw new Error("database failed");
    const previous = this.profiles.get(input.id);
    const profile = { ...input, createdAt: previous?.createdAt ?? 1, updatedAt: 2 };
    this.profiles.set(input.id, profile);
    return profile;
  }
  async delete(id: string) {
    if (this.failDelete) throw new Error("database failed");
    this.profiles.delete(id);
  }
  async getSelectedId() { return this.selectedId; }
  async setSelectedId(id: string | undefined) { this.selectedId = id; }
  async getWebSearchConfig() { return this.webSearchConfig; }
  async setWebSearchConfig(config: WebSearchConfig) {
    this.webSearchConfig = config;
    return config;
  }
  async getLocalMemoryConfig() { return this.localMemoryConfig; }
  async setLocalMemoryConfig(config: LocalMemoryConfig) {
    this.localMemoryConfig = config;
    return config;
  }
  async getCommerceConfig() { return this.commerceConfig; }
  async setCommerceConfig(config: AffiliateCommerceConfig) {
    this.commerceConfig = config;
    return config;
  }
}

describe("ProviderSession", () => {
  it("merges NKG AI as the default provider and authorizes each hosted run", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const hostedStore = {
      installationId: "b130c491-0f3a-4491-a30a-7a281026a42b",
      async getInstallationId() { return this.installationId; },
      async setInstallationId(installationId: string) { this.installationId = installationId; },
    };
    const balance = {
      availablePoints: 300,
      purchasedPoints: 0,
      grantedPoints: 300,
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const models = [{
      id: "nkg-fast",
      name: "NKG Fast",
      contextWindow: 128_000,
      inputPointsPerMillionTokens: 100,
      outputPointsPerMillionTokens: 500,
      capabilities: ["text"],
    }];
    const request = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith("/sessions/anonymous")) {
        return new Response(JSON.stringify({ data: {
          accountId: "account-1",
          appAccountToken: "4dc0c81e-8604-4c10-8e3c-21d363e1702b",
          sessionToken: "hosted-session-token",
          sessionExpiresAt: "2026-09-01T00:00:00.000Z",
          balance,
          models,
          pointPacks: [],
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname.endsWith("/images/generations")) {
        return new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/api/app/v1/search")) {
        return new Response(JSON.stringify({ data: [{
          title: "Steam release",
          url: "https://example.test/release",
          content: "Release notes",
        }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: {
        authorizationId: "auth-1",
        apiBaseUrl: "https://api.example.test/v1",
        apiKey: "run-scoped-token",
        expiresAt: "2026-08-01T00:05:00.000Z",
        balance: { ...balance, availablePoints: 280 },
      } }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const hosted = new HostedAiSession(
      new HostedAiClient("https://account.example.test", request),
      hostedStore,
    );
    const session = new ProviderSession(
      store,
      async () => vault,
      request,
      { session: hosted, platform: "ios", appVersion: "0.1.0" },
    );

    const snapshot = await session.initialize();

    expect(snapshot.selectedProviderId).toBe("nkg-hosted");
    expect(snapshot.profiles[0]).toMatchObject({
      id: "nkg-hosted",
      source: "nkg-hosted",
      defaultModel: "nkg-fast",
    });
    expect(snapshot.webSearch).toMatchObject({
      baseUrl: "https://search.lfzxb.top",
      authMode: "nkg-session",
      enabled: true,
    });
    await expect(session.searchWeb("Steam release", { maxResults: 3 })).resolves.toEqual([{
      title: "Steam release",
      url: "https://example.test/release",
      content: "Release notes",
    }]);
    await expect(session.createRunOptions({}, { flowId: "builtin.chat" })).resolves.toMatchObject({
      envOverrides: {
        variables: {
          LLM_BASE_URL: "https://api.example.test/v1",
          LLM_DEFAULT_MODEL: "nkg-fast",
        },
        secrets: { LLM_API_KEY: "run-scoped-token" },
      },
    });
    expect(session.snapshot.hostedAi?.account?.balance.availablePoints).toBe(280);

    await expect(session.generateImage({
      model: "nkg-fast",
      prompt: "一只紫色机器人",
      size: "1024x1024",
      quality: "medium",
    })).resolves.toMatchObject({
      src: "data:image/png;base64,aW1hZ2U=",
      model: "nkg-fast",
    });
    expect(request.mock.calls.some(([url]) => (url as URL).pathname.endsWith("/images/generations"))).toBe(true);
  });

  it("persists metadata separately and injects the selected vault key", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const session = new ProviderSession(store, async () => vault);
    await session.initialize();
    const saved = await session.save({
      id: "p1",
      name: "Example",
      baseUrl: "https://example.test/v1",
      defaultModel: "model-1",
      enabledModels: ["model-1", "model-2"],
      modelContextWindows: { "model-1": 128_000, "model-2": 200_000 },
      apiKey: "sk-secret",
    });

    expect(saved.selectedProviderId).toBe("p1");
    expect(store.profiles.get("p1")?.apiKeyRef).toBe("provider:p1:api-key");
    expect(JSON.stringify(store.profiles.get("p1"))).not.toContain("sk-secret");
    expect(session.getModelContextWindow("p1", "model-2")).toBe(200_000);
    expect(session.getModelContextWindow("p1", "unknown")).toBe(128_000);
    await expect(session.createRunOptions()).resolves.toMatchObject({
      envOverrides: {
        variables: { LLM_BASE_URL: "https://example.test/v1", LLM_DEFAULT_MODEL: "model-1" },
        secrets: { LLM_API_KEY: "sk-secret" },
      },
    });
    await expect(session.createRunOptions({ envOverrides: { variables: { LLM_DEFAULT_MODEL: "model-2" } } }))
      .resolves.toMatchObject({ envOverrides: { variables: { LLM_DEFAULT_MODEL: "model-2" } } });
    await expect(session.createRunOptions({ envOverrides: { variables: { LLM_DEFAULT_MODEL: "hidden-model" } } }))
      .rejects.toThrow("未在当前模型服务中启用");
  });

  it("restores the previous key when metadata persistence fails", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const session = new ProviderSession(store, async () => vault);
    await session.initialize();
    await session.save({ id: "p1", name: "One", baseUrl: "https://one.test/v1", defaultModel: "m1", enabledModels: ["m1"], apiKey: "old-key" });
    store.failUpsert = true;

    await expect(session.save({ id: "p1", name: "One", baseUrl: "https://one.test/v1", defaultModel: "m1", enabledModels: ["m1"], apiKey: "new-key" })).rejects.toThrow("database failed");
    expect(vault.values.get("provider:p1:api-key")).toBe("old-key");
  });

  it("restores a key when profile deletion fails and locks without retaining state", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const session = new ProviderSession(store, async () => vault);
    await session.initialize();
    await session.save({ id: "p1", name: "One", baseUrl: "https://one.test/v1", defaultModel: "m1", enabledModels: ["m1"], apiKey: "key" });
    store.failDelete = true;
    await expect(session.delete("p1")).rejects.toThrow("database failed");
    expect(vault.values.get("provider:p1:api-key")).toBe("key");

    await session.lock();
    expect(session.snapshot).toEqual({ unlocked: false, profiles: [] });
    expect(vault.locked).toBe(true);
  });

  it("requires an explicit acknowledgement before persisting a plaintext HTTP Provider", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const session = new ProviderSession(store, async () => vault);
    await session.initialize();
    const draft = {
      id: "local",
      name: "Local model",
      baseUrl: "http://192.168.1.8:11434/v1",
      defaultModel: "local-model",
      enabledModels: ["local-model"],
      apiKey: "local-key",
    };

    await expect(session.save(draft)).rejects.toThrow("必须确认风险");
    expect(store.profiles.size).toBe(0);
    expect(vault.values.size).toBe(0);

    await expect(session.save({ ...draft, allowInsecureHttp: true }))
      .resolves.toMatchObject({ selectedProviderId: "local" });
  });

  it("discovers and normalizes OpenAI-compatible model lists", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(fetchCompatibleModels("https://example.test/v1/", "secret", request))
      .resolves.toEqual(["model-a", "model-b"]);
    expect(request).toHaveBeenCalledWith(new URL("https://example.test/v1/models"), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer secret" }),
    }));
  });

  it("pings a specific model with a minimal non-streaming completion", async () => {
    const request = vi.fn(async (_url: URL, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "pong" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(pingCompatibleModel(
      "https://example.test/v1/",
      "secret",
      "model-a",
      request,
    )).resolves.toBeGreaterThanOrEqual(1);
    expect(request).toHaveBeenCalledWith(
      new URL("https://example.test/v1/chat/completions"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      model: "model-a",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    });
  });

  it("surfaces a compatible model ping error without exposing a full response body", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "model is unavailable" },
    }), { status: 503, headers: { "Content-Type": "application/json" } }));

    await expect(pingCompatibleModel("https://example.test/v1", "secret", "model-a", request))
      .rejects.toThrow("Ping 失败：HTTP 503 · model is unavailable");
  });

  it("stores SearXNG metadata separately and authenticates with X-API-Key", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const request = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { title: "Result", url: "https://example.test/article", content: "Summary", engine: "bing" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const session = new ProviderSession(store, async () => vault, request);
    await session.initialize();

    await session.saveWebSearch({
      baseUrl: "https://search.example.test/",
      apiKey: "search-secret",
      authMode: "x-api-key",
      enabled: true,
    });
    const results = await session.searchWeb("latest release");

    expect(store.webSearchConfig).toEqual({
      provider: "searxng",
      baseUrl: "https://search.example.test/",
      apiKeyRef: "search:searxng:api-key",
      authMode: "x-api-key",
      enabled: true,
    });
    expect(JSON.stringify(store.webSearchConfig)).not.toContain("search-secret");
    expect(results).toEqual([{
      title: "Result",
      url: "https://example.test/article",
      content: "Summary",
      engine: "bing",
    }]);
    expect(request).toHaveBeenCalledWith(
      new URL("https://search.example.test/search?q=latest+release&format=json"),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-API-Key": "search-secret" }),
      }),
    );
  });

  it("supports an unauthenticated self-hosted SearXNG without leaking an old key", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const request = vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: "Result", url: "https://example.test/article", content: "Summary" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const session = new ProviderSession(store, async () => vault, request);
    await session.initialize();
    await session.saveWebSearch({
      baseUrl: "https://search.example.test",
      apiKey: "",
      authMode: "none",
      enabled: true,
    });

    await session.searchWeb("latest release");

    expect(store.webSearchConfig?.authMode).toBe("none");
    expect(request).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      headers: { Accept: "application/json" },
    }));
  });

  it("enables the local BGE model by default and verifies it without a provider key", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const embed = vi.fn(async () => [Array.from({ length: 512 }, () => 0.01)]);
    const session = new ProviderSession(
      store,
      async () => vault,
      globalThis.fetch,
      undefined,
      () => ({ embed }),
    );

    const snapshot = await session.initialize();

    expect(snapshot.localMemory).toMatchObject({
      enabled: true,
      autoArchive: true,
      semanticSearch: true,
      embeddingMode: "local",
      embeddingModel: "Xenova/bge-small-zh-v1.5",
    });
    await expect(session.testLocalMemorySemanticSearch({
      enabled: true,
      autoArchive: true,
      semanticSearch: true,
      embeddingMode: "local",
      embeddingProviderId: "",
      embeddingModel: "Xenova/bge-small-zh-v1.5",
    })).resolves.toBe(512);
    expect(embed).toHaveBeenCalledWith(
      ["本地记忆语义检索连接测试"],
      ["query"],
      undefined,
    );
  });

  it("tests a configured cloud embedding model for local semantic memory", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const request = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.25, 0.5, 0.75] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const session = new ProviderSession(store, async () => vault, request);
    await session.initialize();
    await session.save({
      id: "embedding-provider",
      name: "Embedding API",
      baseUrl: "https://embedding.example.test/v1",
      defaultModel: "chat-model",
      enabledModels: ["chat-model"],
      apiKey: "embedding-secret",
    });

    await session.saveLocalMemory({
      enabled: true,
      autoArchive: true,
      semanticSearch: true,
      embeddingMode: "cloud",
      embeddingProviderId: "embedding-provider",
      embeddingModel: "bge-m3",
    });
    await expect(session.testLocalMemorySemanticSearch({
      enabled: true,
      autoArchive: true,
      semanticSearch: true,
      embeddingMode: "cloud",
      embeddingProviderId: "embedding-provider",
      embeddingModel: "bge-m3",
    })).resolves.toBe(3);

    expect(store.localMemoryConfig).toMatchObject({
      provider: "local",
      enabled: true,
      semanticSearch: true,
      embeddingMode: "cloud",
      embeddingModel: "bge-m3",
    });
    expect(request).toHaveBeenCalledWith(
      new URL("https://embedding.example.test/v1/embeddings"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer embedding-secret" }),
      }),
    );
  });

  it("reports SearXNG authentication failures without exposing the key", async () => {
    const request = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const error = await fetchSearxngResults(
      "https://search.example.test",
      "never-print-this",
      "test",
      request,
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("HTTP 401");
    expect((error as Error).message).not.toContain("never-print-this");
  });

  it("stores affiliate credentials in the vault and uses them for PDD search and promotion", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const request = vi.fn(async () => {
      if (request.mock.calls.length === 1) {
        return new Response(JSON.stringify({
          goods_search_response: {
            search_id: "search-1",
            goods_list: [{
              goods_name: "七彩虹 RTX 4060 8GB 游戏显卡",
              goods_sign: "gpu-1",
              min_group_price: 299900,
              has_coupon: false,
              mall_name: "品牌旗舰店",
              merchant_type: 3,
            }],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        goods_promotion_url_generate_response: {
          goods_promotion_url_list: [{ short_url: "https://p.pinduoduo.com/affiliate" }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const session = new ProviderSession(store, async () => vault, request);
    await session.initialize();

    await session.saveCommerce({
      provider: "pdd",
      enabled: true,
      key: "pdd-client-id",
      secret: "pdd-client-secret",
      accessToken: "pdd-access-token",
      refreshToken: "pdd-refresh-token",
      pid: "100_200",
    });
    const products = await session.testCommerce({
      provider: "pdd",
      enabled: true,
      key: "",
      secret: "",
      accessToken: "",
      refreshToken: "",
      pid: "100_200",
    });

    expect(store.commerceConfig).toEqual({
      enabled: true,
      selectedProvider: "pdd",
      pdd: {
        clientIdRef: "commerce:pdd:client-id",
        clientSecretRef: "commerce:pdd:client-secret",
        accessTokenRef: "commerce:pdd:access-token",
        refreshTokenRef: "commerce:pdd:refresh-token",
        pid: "100_200",
      },
    });
    expect(JSON.stringify(store.commerceConfig)).not.toContain("pdd-client-secret");
    expect(vault.values.get("commerce:pdd:client-id")).toBe("pdd-client-id");
    expect(vault.values.get("commerce:pdd:client-secret")).toBe("pdd-client-secret");
    expect(vault.values.get("commerce:pdd:access-token")).toBe("pdd-access-token");
    expect(vault.values.get("commerce:pdd:refresh-token")).toBe("pdd-refresh-token");
    await session.save({
      id: "model",
      name: "Model",
      baseUrl: "https://model.example.test/v1",
      defaultModel: "model-1",
      enabledModels: ["model-1"],
      apiKey: "model-secret",
    });
    await session.saveWebSearch({
      baseUrl: "https://search.example.test",
      apiKey: "market-search-secret",
      authMode: "x-api-key",
      enabled: true,
    });
    const computerOptions = await session.createRunOptions({}, { flowId: "computer_config_advisor" });
    expect(computerOptions).toMatchObject({
        envOverrides: {
          variables: {
            AFFILIATE_COMMERCE_ENABLED: true,
            AFFILIATE_COMMERCE_PROVIDER: "pdd",
            AFFILIATE_PDD_PID: "100_200",
            PUBLIC_MARKET_SEARCH_ENABLED: true,
            PUBLIC_MARKET_SEARCH_MODE: "searxng",
            PUBLIC_MARKET_SEARCH_BASE_URL: "https://search.example.test",
          },
          secrets: {
            AFFILIATE_PDD_CLIENT_ID: "pdd-client-id",
            AFFILIATE_PDD_CLIENT_SECRET: "pdd-client-secret",
            AFFILIATE_PDD_ACCESS_TOKEN: "pdd-access-token",
            PUBLIC_MARKET_SEARCH_API_KEY: "market-search-secret",
          },
        },
      });
    const ordinaryOptions = await session.createRunOptions({}, { flowId: "builtin_chat" });
    expect(ordinaryOptions.envOverrides?.secrets).not.toHaveProperty("AFFILIATE_PDD_CLIENT_SECRET");
    expect(products).toEqual([expect.objectContaining({
      name: "七彩虹 RTX 4060 8GB 游戏显卡",
      promotionUrl: "https://p.pinduoduo.com/affiliate",
      affiliate: true,
    })]);
  });

  it("blocks computer advisor runs until affiliate credentials are saved", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const session = new ProviderSession(store, async () => vault, vi.fn());
    await session.initialize();
    await session.save({
      id: "model",
      name: "Model",
      baseUrl: "https://model.example.test/v1",
      defaultModel: "model-1",
      enabledModels: ["model-1"],
      apiKey: "model-secret",
    });

    await expect(session.createRunOptions({}, { flowId: "computer_config_advisor" }))
      .rejects.toThrow("尚未完成安全初始化");
  });

  it("moves a one-time PDD bootstrap directly into Stronghold-backed storage", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const session = new ProviderSession(
      store,
      async () => vault,
      vi.fn(),
      undefined,
      undefined,
      async () => ({
        clientId: "bootstrap-client-id",
        clientSecret: "bootstrap-client-secret",
        accessToken: "bootstrap-access-token",
        pid: "100_200",
      }),
    );

    await session.initialize();

    expect(store.commerceConfig).toMatchObject({
      enabled: true,
      selectedProvider: "pdd",
      pdd: { pid: "100_200" },
    });
    expect(vault.values.get("commerce:pdd:client-id")).toBe("bootstrap-client-id");
    expect(vault.values.get("commerce:pdd:client-secret")).toBe("bootstrap-client-secret");
    expect(vault.values.get("commerce:pdd:access-token")).toBe("bootstrap-access-token");
    expect(JSON.stringify(store.commerceConfig)).not.toContain("bootstrap-client-secret");
  });

  it("exchanges a one-time PDD authorization code and stores authoritative token metadata", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const expiresAt = Date.parse("2026-08-12T00:00:00.000Z") / 1000;
    const refreshExpiresAt = Date.parse("2026-09-10T00:00:00.000Z") / 1000;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("type")).toBe("pdd.pop.auth.token.create");
      expect(url.searchParams.get("code")).toBe("bootstrap-authorization-code");
      return new Response(JSON.stringify({
        pop_auth_token_create_response: {
          access_token: "created-access-token",
          expires_at: expiresAt,
          refresh_token: "created-refresh-token",
          refresh_token_expires_at: refreshExpiresAt,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const session = new ProviderSession(
      store,
      async () => vault,
      request,
      undefined,
      undefined,
      async () => ({
        clientId: "bootstrap-client-id",
        clientSecret: "bootstrap-client-secret",
        authorizationCode: "bootstrap-authorization-code",
        pid: "100_200",
      }),
    );

    await session.initialize();

    expect(request).toHaveBeenCalledTimes(1);
    expect(vault.values.get("commerce:pdd:access-token")).toBe("created-access-token");
    expect(vault.values.get("commerce:pdd:refresh-token")).toBe("created-refresh-token");
    expect(store.commerceConfig?.pdd).toMatchObject({
      accessTokenExpiresAt: "2026-08-12T00:00:00.000Z",
      refreshTokenExpiresAt: "2026-09-10T00:00:00.000Z",
    });
  });

  it("exchanges a one-time PDD authorization code with credentials loaded only from Stronghold", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    store.commerceConfig = {
      enabled: true,
      selectedProvider: "pdd",
      pdd: {
        clientIdRef: "commerce:pdd:client-id",
        clientSecretRef: "commerce:pdd:client-secret",
        accessTokenRef: "commerce:pdd:access-token",
        pid: "100_200",
      },
    };
    vault.values.set("commerce:pdd:client-id", "stored-client-id");
    vault.values.set("commerce:pdd:client-secret", "stored-client-secret");
    vault.values.set("commerce:pdd:access-token", "expired-access-token");
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("client_id")).toBe("stored-client-id");
      expect(url.searchParams.get("code")).toBe("bootstrap-authorization-code");
      return new Response(JSON.stringify({
        pop_auth_token_create_response: {
          access_token: "created-access-token",
          expires_in: 3600,
          refresh_token: "created-refresh-token",
          refresh_token_expires_in: 7200,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const session = new ProviderSession(
      store,
      async () => vault,
      request,
      undefined,
      undefined,
      async () => ({ authorizationCode: "bootstrap-authorization-code" }),
    );

    await session.initialize();

    expect(request).toHaveBeenCalledTimes(1);
    expect(vault.values.get("commerce:pdd:access-token")).toBe("created-access-token");
    expect(vault.values.get("commerce:pdd:refresh-token")).toBe("created-refresh-token");
    expect(store.commerceConfig?.pdd).toMatchObject({
      pid: "100_200",
      refreshTokenRef: "commerce:pdd:refresh-token",
    });
  });

  it("refreshes an expiring PDD OAuth token before a computer advisor run", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    store.commerceConfig = {
      enabled: true,
      selectedProvider: "pdd",
      pdd: {
        clientIdRef: "commerce:pdd:client-id",
        clientSecretRef: "commerce:pdd:client-secret",
        accessTokenRef: "commerce:pdd:access-token",
        refreshTokenRef: "commerce:pdd:refresh-token",
        accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
        pid: "100_200",
      },
    };
    vault.values.set("commerce:pdd:client-id", "pdd-client-id");
    vault.values.set("commerce:pdd:client-secret", "pdd-client-secret");
    vault.values.set("commerce:pdd:access-token", "expired-access-token");
    vault.values.set("commerce:pdd:refresh-token", "pdd-refresh-token");
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("type")).toBe("pdd.pop.auth.token.refresh");
      return new Response(JSON.stringify({
        pop_auth_token_refresh_response: {
          access_token: "fresh-access-token",
          expires_in: 3600,
          refresh_token: "fresh-refresh-token",
          refresh_expires_in: 7200,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const session = new ProviderSession(store, async () => vault, request);
    await session.initialize();
    await session.save({
      id: "model",
      name: "Model",
      baseUrl: "https://model.example.test/v1",
      defaultModel: "model-1",
      enabledModels: ["model-1"],
      apiKey: "model-secret",
    });

    const options = await session.createRunOptions({}, { flowId: "computer_config_advisor" });

    expect(request).toHaveBeenCalledTimes(1);
    expect(vault.values.get("commerce:pdd:access-token")).toBe("fresh-access-token");
    expect(vault.values.get("commerce:pdd:refresh-token")).toBe("fresh-refresh-token");
    expect(store.commerceConfig?.pdd?.accessTokenExpiresAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(options.envOverrides?.secrets?.AFFILIATE_PDD_ACCESS_TOKEN).toBe("fresh-access-token");
  });

  it("generates images with an enabled model and the selected provider secret", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const request = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: "aW1hZ2U=" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const session = new ProviderSession(store, async () => vault, request);
    await session.initialize();
    await session.save({
      id: "image-provider",
      name: "Images",
      baseUrl: "https://images.example.test/v1",
      defaultModel: "gpt-image-2",
      enabledModels: ["gpt-image-2"],
      apiKey: "image-secret",
    });

    await expect(session.generateImage({
      model: "gpt-image-2",
      prompt: "a test image",
      size: "1024x1024",
      quality: "low",
    })).resolves.toMatchObject({ mode: "generation", model: "gpt-image-2" });
    expect(request).toHaveBeenCalledWith(
      new URL("https://images.example.test/v1/images/generations"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer image-secret" }),
      }),
    );

    await expect(session.generateImage({
      model: "disabled-image-model",
      prompt: "a test image",
      size: "1024x1024",
      quality: "low",
    })).rejects.toThrow("未在当前模型服务中启用");
  });
});
