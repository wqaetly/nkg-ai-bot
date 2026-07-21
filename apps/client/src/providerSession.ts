import type { FlowInvokeOptions } from "@nkg-ai-bot/runtime-router";
import { withProviderEnvironment } from "./providerRuntime";
import { INSECURE_PROVIDER_WARNING, isPlainHttpProviderUrl } from "./providerSecurity";
import {
  deleteProviderProfile,
  getSelectedProviderId,
  listProviderProfiles,
  setSelectedProviderId,
  upsertProviderProfile,
  type ProviderProfile,
  type ProviderProfileInput,
} from "./storage/database";
import { SecretVault, type ApiKeyVault } from "./storage/secretVault";

export interface ProviderDraft {
  id?: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  enabledModels: string[];
  /** Empty on edit means keep the existing key. */
  apiKey: string;
  /** Must be explicitly true for each save that uses a plaintext HTTP URL. */
  allowInsecureHttp?: boolean;
}

export interface ProviderSessionSnapshot {
  unlocked: boolean;
  profiles: ProviderProfile[];
  selectedProviderId?: string;
}

export interface ProviderDataStore {
  list(): Promise<ProviderProfile[]>;
  upsert(profile: ProviderProfileInput): Promise<ProviderProfile>;
  delete(id: string): Promise<void>;
  getSelectedId(): Promise<string | undefined>;
  setSelectedId(id: string | undefined): Promise<void>;
}

const sqliteProviderStore: ProviderDataStore = {
  list: () => listProviderProfiles(),
  upsert: (profile) => upsertProviderProfile(profile),
  delete: (id) => deleteProviderProfile(id),
  getSelectedId: () => getSelectedProviderId(),
  setSelectedId: (id) => setSelectedProviderId(id),
};

export class ProviderSession {
  private vault: ApiKeyVault | undefined;
  private snapshotValue: ProviderSessionSnapshot = { unlocked: false, profiles: [] };
  private readonly subscribers = new Set<() => void>();
  private initialization: Promise<ProviderSessionSnapshot> | undefined;

  constructor(
    private readonly dataStore: ProviderDataStore = sqliteProviderStore,
    private readonly openVault: () => Promise<ApiKeyVault> = SecretVault.openAutomatically,
    private readonly fetchImpl: typeof globalThis.fetch = (...args) => import("@tauri-apps/plugin-http")
      .then(({ fetch }) => fetch(...args)),
  ) {}

  get snapshot(): ProviderSessionSnapshot {
    return {
      ...this.snapshotValue,
      profiles: [...this.snapshotValue.profiles],
    };
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  initialize(): Promise<ProviderSessionSnapshot> {
    if (this.vault) return this.refresh();
    this.initialization ??= this.openAndRefresh().finally(() => { this.initialization = undefined; });
    return this.initialization;
  }

  private async openAndRefresh(): Promise<ProviderSessionSnapshot> {
    const vault = await this.openVault();
    this.vault = vault;
    try { return await this.refresh(); }
    catch (error) {
      this.vault = undefined;
      await vault.lock().catch(() => undefined);
      throw error;
    }
  }

  async lock(): Promise<void> {
    const vault = this.vault;
    this.vault = undefined;
    this.snapshotValue = { unlocked: false, profiles: [] };
    this.notify();
    await vault?.lock();
  }

  async refresh(): Promise<ProviderSessionSnapshot> {
    this.requireVault();
    const [profiles, storedSelection] = await Promise.all([
      this.dataStore.list(),
      this.dataStore.getSelectedId(),
    ]);
    const selectedProviderId = profiles.some((profile) => profile.id === storedSelection)
      ? storedSelection
      : profiles[0]?.id;
    if (selectedProviderId !== storedSelection) {
      await this.dataStore.setSelectedId(selectedProviderId);
    }
    this.snapshotValue = {
      unlocked: true,
      profiles,
      ...(selectedProviderId ? { selectedProviderId } : {}),
    };
    this.notify();
    return this.snapshot;
  }

  async save(draft: ProviderDraft): Promise<ProviderSessionSnapshot> {
    const vault = this.requireVault();
    if (isPlainHttpProviderUrl(draft.baseUrl) && draft.allowInsecureHttp !== true) {
      throw new Error(`保存明文 HTTP Provider 前必须确认风险。${INSECURE_PROVIDER_WARNING}`);
    }
    const id = draft.id?.trim() || crypto.randomUUID();
    const apiKeyRef = `provider:${id}:api-key`;
    const previousKey = await vault.getApiKey(apiKeyRef);
    const nextKey = draft.apiKey.trim();
    if (!nextKey && !previousKey) throw new Error("API Key is required for a new provider");

    if (nextKey) await vault.setApiKey(apiKeyRef, nextKey);
    try {
      await this.dataStore.upsert({
        id,
        name: draft.name,
        baseUrl: draft.baseUrl,
        defaultModel: draft.defaultModel,
        enabledModels: draft.enabledModels,
        apiKeyRef,
      });
    } catch (error) {
      if (nextKey) {
        if (previousKey) await vault.setApiKey(apiKeyRef, previousKey);
        else await vault.removeApiKey(apiKeyRef);
      }
      throw error;
    }

    if (!this.snapshotValue.selectedProviderId) {
      await this.dataStore.setSelectedId(id);
    }
    return this.refresh();
  }

  async select(id: string): Promise<ProviderSessionSnapshot> {
    this.requireVault();
    if (!this.snapshotValue.profiles.some((profile) => profile.id === id)) {
      throw new Error("Cannot select an unknown provider");
    }
    await this.dataStore.setSelectedId(id);
    this.snapshotValue = { ...this.snapshotValue, selectedProviderId: id };
    this.notify();
    return this.snapshot;
  }

  async delete(id: string): Promise<ProviderSessionSnapshot> {
    const vault = this.requireVault();
    const profile = this.snapshotValue.profiles.find((candidate) => candidate.id === id);
    if (!profile) return this.snapshot;
    const previousKey = await vault.getApiKey(profile.apiKeyRef);
    if (previousKey) await vault.removeApiKey(profile.apiKeyRef);
    try {
      await this.dataStore.delete(id);
    } catch (error) {
      if (previousKey) await vault.setApiKey(profile.apiKeyRef, previousKey);
      throw error;
    }
    return this.refresh();
  }

  async createRunOptions(options: FlowInvokeOptions = {}): Promise<FlowInvokeOptions> {
    const vault = this.requireVault();
    const selected = this.snapshotValue.profiles.find(
      (profile) => profile.id === this.snapshotValue.selectedProviderId,
    );
    if (!selected) throw new Error("No model provider is selected");
    const requestedModel = options.envOverrides?.variables?.LLM_DEFAULT_MODEL;
    const model = typeof requestedModel === "string" && requestedModel.trim()
      ? requestedModel.trim()
      : selected.defaultModel;
    if (!selected.enabledModels.includes(model)) {
      throw new Error(`模型“${model}”未在 OpenAI 设置中启用`);
    }
    return withProviderEnvironment(selected, vault, options, model);
  }

  async discoverModels(draft: ProviderDraft, signal?: AbortSignal): Promise<string[]> {
    const vault = this.requireVault();
    if (isPlainHttpProviderUrl(draft.baseUrl) && draft.allowInsecureHttp !== true) {
      throw new Error(`通过明文 HTTP 获取模型前必须确认风险。${INSECURE_PROVIDER_WARNING}`);
    }
    const id = draft.id?.trim();
    const profile = id ? this.snapshotValue.profiles.find((item) => item.id === id) : undefined;
    const apiKey = draft.apiKey.trim() || (profile ? await vault.getApiKey(profile.apiKeyRef) : undefined);
    if (!apiKey) throw new Error("请先填写 API Key，再获取模型列表");
    return fetchCompatibleModels(draft.baseUrl, apiKey, this.fetchImpl, signal);
  }

  private requireVault(): ApiKeyVault {
    if (!this.vault) throw new Error("Local secret vault is locked");
    return this.vault;
  }

  private notify(): void {
    for (const subscriber of this.subscribers) subscriber();
  }
}

export async function fetchCompatibleModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<string[]> {
  const normalized = new URL(baseUrl.trim());
  if (!['http:', 'https:'].includes(normalized.protocol)) throw new Error("API URL 必须使用 HTTP 或 HTTPS");
  normalized.pathname = `${normalized.pathname.replace(/\/$/, "")}/models`;
  normalized.search = "";
  normalized.hash = "";
  const response = await fetchImpl(normalized, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`获取模型失败：HTTP ${response.status}`);
  const payload = await response.json() as unknown;
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : payload && typeof payload === "object" && Array.isArray((payload as { models?: unknown }).models)
        ? (payload as { models: unknown[] }).models
        : [];
  const models = [...new Set(rows.map((row) => {
    if (typeof row === "string") return row.trim();
    if (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string") {
      return (row as { id: string }).id.trim();
    }
    return "";
  }).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  if (!models.length) throw new Error("接口返回成功，但没有发现可用模型");
  return models;
}

export const providerSession = new ProviderSession();
