import { describe, expect, it } from "vitest";
import { ProviderSession, type ProviderDataStore } from "../src/providerSession";
import type { ProviderProfile, ProviderProfileInput } from "../src/storage/database";
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
}

describe("ProviderSession", () => {
  it("persists metadata separately and injects the selected vault key", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const session = new ProviderSession(store, async () => vault);
    await session.unlock("password-123");
    const saved = await session.save({
      id: "p1",
      name: "Example",
      baseUrl: "https://example.test/v1",
      defaultModel: "model-1",
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
  });

  it("restores the previous key when metadata persistence fails", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const session = new ProviderSession(store, async () => vault);
    await session.unlock("password-123");
    await session.save({ id: "p1", name: "One", baseUrl: "https://one.test/v1", defaultModel: "m1", apiKey: "old-key" });
    store.failUpsert = true;

    await expect(session.save({ id: "p1", name: "One", baseUrl: "https://one.test/v1", defaultModel: "m1", apiKey: "new-key" })).rejects.toThrow("database failed");
    expect(vault.values.get("provider:p1:api-key")).toBe("old-key");
  });

  it("restores a key when profile deletion fails and locks without retaining state", async () => {
    const vault = new MemoryVault();
    const store = new MemoryStore();
    const session = new ProviderSession(store, async () => vault);
    await session.unlock("password-123");
    await session.save({ id: "p1", name: "One", baseUrl: "https://one.test/v1", defaultModel: "m1", apiKey: "key" });
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
    await session.unlock("password-123");
    const draft = {
      id: "local",
      name: "Local model",
      baseUrl: "http://192.168.1.8:11434/v1",
      defaultModel: "local-model",
      apiKey: "local-key",
    };

    await expect(session.save(draft)).rejects.toThrow("必须确认风险");
    expect(store.profiles.size).toBe(0);
    expect(vault.values.size).toBe(0);

    await expect(session.save({ ...draft, allowInsecureHttp: true }))
      .resolves.toMatchObject({ selectedProviderId: "local" });
  });
});
