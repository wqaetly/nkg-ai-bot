import { describe, expect, it, vi } from "vitest";
import {
  fetchCompatibleModels,
  fetchSearxngResults,
  ProviderSession,
  type ProviderDataStore,
} from "../src/providerSession";
import type {
  ProviderProfile,
  ProviderProfileInput,
  WebSearchConfig,
} from "../src/storage/database";
import type { ApiKeyVault } from "../src/storage/secretVault";

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
}

describe("ProviderSession", () => {
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
      apiKey: "sk-secret",
    });

    expect(saved.selectedProviderId).toBe("p1");
    expect(store.profiles.get("p1")?.apiKeyRef).toBe("provider:p1:api-key");
    expect(JSON.stringify(store.profiles.get("p1"))).not.toContain("sk-secret");
    await expect(session.createRunOptions()).resolves.toMatchObject({
      envOverrides: {
        variables: { LLM_BASE_URL: "https://example.test/v1", LLM_DEFAULT_MODEL: "model-1" },
        secrets: { LLM_API_KEY: "sk-secret" },
      },
    });
    await expect(session.createRunOptions({ envOverrides: { variables: { LLM_DEFAULT_MODEL: "model-2" } } }))
      .resolves.toMatchObject({ envOverrides: { variables: { LLM_DEFAULT_MODEL: "model-2" } } });
    await expect(session.createRunOptions({ envOverrides: { variables: { LLM_DEFAULT_MODEL: "hidden-model" } } }))
      .rejects.toThrow("未在 OpenAI 设置中启用");
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
      enabled: true,
    });
    const results = await session.searchWeb("latest release");

    expect(store.webSearchConfig).toEqual({
      provider: "searxng",
      baseUrl: "https://search.example.test/",
      apiKeyRef: "search:searxng:api-key",
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
    })).rejects.toThrow("未在 OpenAI 设置中启用");
  });
});
