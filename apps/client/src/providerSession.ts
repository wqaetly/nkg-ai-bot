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

  constructor(
    private readonly dataStore: ProviderDataStore = sqliteProviderStore,
    private readonly unlockVault: (password: string) => Promise<ApiKeyVault> = SecretVault.unlock,
  ) {}

  get snapshot(): ProviderSessionSnapshot {
    return {
      ...this.snapshotValue,
      profiles: [...this.snapshotValue.profiles],
    };
  }

  async unlock(password: string): Promise<ProviderSessionSnapshot> {
    if (this.vault) return this.refresh();
    const vault = await this.unlockVault(password);
    this.vault = vault;
    try {
      return await this.refresh();
    } catch (error) {
      this.vault = undefined;
      await vault.lock().catch(() => undefined);
      throw error;
    }
  }

  async lock(): Promise<void> {
    const vault = this.vault;
    this.vault = undefined;
    this.snapshotValue = { unlocked: false, profiles: [] };
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
    return withProviderEnvironment(selected, vault, options);
  }

  private requireVault(): ApiKeyVault {
    if (!this.vault) throw new Error("Local secret vault is locked");
    return this.vault;
  }
}

export const providerSession = new ProviderSession();
