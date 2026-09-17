import type { FlowInvokeOptions } from "@nkg-ai-bot/runtime-router";
import { invoke } from "@tauri-apps/api/core";
import {
  AFFILIATE_ENV_KEYS,
  PUBLIC_MARKET_SEARCH_ENV_KEYS,
  createPddAccessToken,
  generatePddAuthorizationUrl,
  refreshPddAccessToken,
  searchAffiliateProducts,
  type AffiliateCommerceConfig,
  type AffiliateCredentials,
  type AffiliateProduct,
  type CommerceProvider,
} from "@nkg-ai-bot/commerce-flow";
import { COMPUTER_CONFIG_FLOW_ID } from "./builtinFlows";
import {
  requestImageGeneration,
  type ImageGenerationRequest,
  type ImageGenerationResult,
} from "./imageGeneration";
import { withProviderEnvironment } from "./providerRuntime";
import { INSECURE_PROVIDER_WARNING, isPlainHttpProviderUrl } from "./providerSecurity";
import {
  addMemosTurn,
  searchMemosMemories,
  testMemosConnection,
  type MemorySearchOptions,
  type RemoteMemory,
} from "./memoryGateway";
import {
  backfillLocalMemoryEmbeddings,
  memoryEmbeddingModelKey,
  requestTextEmbeddings,
  searchLocalMemoriesSemantically,
} from "./localMemorySearch";
import {
  LOCAL_EMBEDDING_MODEL_ID,
  LOCAL_EMBEDDING_MODEL_KEY,
  LocalEmbeddingWorkerClient,
  type LocalTextEmbedder,
} from "./localEmbedding";
import { listRelevantMemories, type MemoryItem } from "./learningRepository";
import {
  DEFAULT_LOCAL_MEMORY_CONFIG,
  deleteProviderProfile,
  getAffiliateCommerceConfig,
  getLocalMemoryConfig,
  getMemoryServiceConfig,
  getWebSearchConfig,
  getSelectedProviderId,
  listProviderProfiles,
  resolveModelContextWindow,
  setAffiliateCommerceConfig,
  setLocalMemoryConfig,
  setMemoryServiceConfig,
  setWebSearchConfig,
  setSelectedProviderId,
  upsertProviderProfile,
  type ProviderProfile,
  type ProviderProfileInput,
  type MemoryServiceConfig,
  type LocalMemoryConfig,
  type WebSearchConfig,
} from "./storage/database";
import { SecretVault, type ApiKeyVault } from "./storage/secretVault";
import {
  DEFAULT_HOSTED_AI_SERVICE_URL,
  HOSTED_AI_PROVIDER_ID,
  HOSTED_AI_SESSION_TOKEN_REF,
  type HostedAiPlatform,
} from "./hostedAi";
import { HostedAiSession, type HostedAiSessionSnapshot } from "./hostedAiSession";
import {
  HostedAiPurchaseController,
  type HostedAiPurchasesSnapshot,
} from "./hostedAiPurchases";

export interface ProviderDraft {
  id?: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  enabledModels: string[];
  modelContextWindows?: Record<string, number>;
  /** Empty on edit means keep the existing key. */
  apiKey: string;
  /** Must be explicitly true for each save that uses a plaintext HTTP URL. */
  allowInsecureHttp?: boolean;
}

export interface ProviderSessionSnapshot {
  unlocked: boolean;
  profiles: ProviderProfile[];
  selectedProviderId?: string;
  webSearch?: WebSearchConfig;
  localMemory?: LocalMemoryConfig;
  memory?: MemoryServiceConfig;
  commerce?: AffiliateCommerceConfig;
  hostedAi?: HostedAiSessionSnapshot;
  hostedPurchases?: HostedAiPurchasesSnapshot;
}

export interface HostedAiProviderConfig {
  session: HostedAiSession;
  platform: HostedAiPlatform;
  appVersion: string;
  serviceUrl?: string;
  purchases?: HostedAiPurchaseController;
}

export interface CommerceDraft {
  provider: CommerceProvider;
  enabled: boolean;
  /** Empty on edit means keep the existing identifier. */
  key: string;
  /** Empty on edit means keep the existing secret. */
  secret: string;
  /** PDD OAuth Access Token. Empty on edit keeps the encrypted value. */
  accessToken?: string;
  /** Optional PDD refresh token used for unattended renewal. */
  refreshToken?: string;
  /** Authoritative expiry returned by Pinduoduo. Never infer it from import time. */
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  pid: string;
  siteId?: string;
  positionId?: string;
}

export interface WebSearchDraft {
  baseUrl: string;
  /** Empty on edit means keep the existing key. */
  apiKey: string;
  authMode: "none" | "x-api-key" | "nkg-session";
  enabled: boolean;
  /** Must be explicitly true for each save that uses a plaintext HTTP URL. */
  allowInsecureHttp?: boolean;
}

export interface MemoryServiceDraft {
  baseUrl: string;
  userId: string;
  /** Empty on edit means keep the existing key. */
  apiKey: string;
  enabled: boolean;
  /** Must be explicitly true for each save that uses a plaintext HTTP URL. */
  allowInsecureHttp?: boolean;
}

export interface PddCommerceBootstrap {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  /** One-time authorization code exchanged locally and never persisted. */
  authorizationCode?: string;
  pid?: string;
  refreshToken?: string;
}

export interface LocalMemoryDraft {
  enabled: boolean;
  autoArchive: boolean;
  semanticSearch: boolean;
  embeddingMode: "local" | "cloud";
  embeddingProviderId: string;
  embeddingModel: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  engine?: string;
}

export interface WebSearchQueryOptions {
  signal?: AbortSignal;
  maxResults?: number;
}

export interface ProviderImageGenerationRequest extends ImageGenerationRequest {
  providerId?: string;
}

export interface ProviderDataStore {
  list(): Promise<ProviderProfile[]>;
  upsert(profile: ProviderProfileInput): Promise<ProviderProfile>;
  delete(id: string): Promise<void>;
  getSelectedId(): Promise<string | undefined>;
  setSelectedId(id: string | undefined): Promise<void>;
  getWebSearchConfig?(): Promise<WebSearchConfig | undefined>;
  setWebSearchConfig?(config: WebSearchConfig): Promise<WebSearchConfig>;
  getMemoryConfig?(): Promise<MemoryServiceConfig | undefined>;
  setMemoryConfig?(config: MemoryServiceConfig): Promise<MemoryServiceConfig>;
  getLocalMemoryConfig?(): Promise<LocalMemoryConfig | undefined>;
  setLocalMemoryConfig?(config: LocalMemoryConfig): Promise<LocalMemoryConfig>;
  getCommerceConfig?(): Promise<AffiliateCommerceConfig | undefined>;
  setCommerceConfig?(config: AffiliateCommerceConfig): Promise<AffiliateCommerceConfig>;
}

const sqliteProviderStore: ProviderDataStore = {
  list: () => listProviderProfiles(),
  upsert: (profile) => upsertProviderProfile(profile),
  delete: (id) => deleteProviderProfile(id),
  getSelectedId: () => getSelectedProviderId(),
  setSelectedId: (id) => setSelectedProviderId(id),
  getWebSearchConfig: () => getWebSearchConfig(),
  setWebSearchConfig: (config) => setWebSearchConfig(config),
  getMemoryConfig: () => getMemoryServiceConfig(),
  setMemoryConfig: (config) => setMemoryServiceConfig(config),
  getLocalMemoryConfig: () => getLocalMemoryConfig(),
  setLocalMemoryConfig: (config) => setLocalMemoryConfig(config),
  getCommerceConfig: () => getAffiliateCommerceConfig(),
  setCommerceConfig: (config) => setAffiliateCommerceConfig(config),
};

export const DEFAULT_SEARXNG_URL = "https://search.lfzxb.top";
export const DEFAULT_SEARXNG_API_KEY = (import.meta.env.VITE_DEFAULT_SEARXNG_API_KEY ?? "").trim();
const WEB_SEARCH_API_KEY_REF = "search:searxng:api-key";
const MEMORY_API_KEY_REF = "memory:memos:api-key";
const JD_APP_KEY_REF = "commerce:jd:app-key";
const JD_SECRET_KEY_REF = "commerce:jd:secret-key";
const PDD_CLIENT_ID_REF = "commerce:pdd:client-id";
const PDD_CLIENT_SECRET_REF = "commerce:pdd:client-secret";
const PDD_ACCESS_TOKEN_REF = "commerce:pdd:access-token";
const PDD_REFRESH_TOKEN_REF = "commerce:pdd:refresh-token";
const PDD_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

export class ProviderSession {
  private vault: ApiKeyVault | undefined;
  private snapshotValue: ProviderSessionSnapshot = { unlocked: false, profiles: [] };
  private readonly subscribers = new Set<() => void>();
  private initialization: Promise<ProviderSessionSnapshot> | undefined;
  private hostedAiConfig: HostedAiProviderConfig | undefined;
  private readonly hostedRunAuthorizations = new WeakMap<FlowInvokeOptions, string>();
  private readonly localEmbeddingBackfills = new Map<string, Promise<void>>();
  private localEmbedder: LocalTextEmbedder | undefined;
  private unsubscribeHostedAi: (() => void) | undefined;
  private unsubscribeHostedPurchases: (() => void) | undefined;

  constructor(
    private readonly dataStore: ProviderDataStore = sqliteProviderStore,
    private readonly openVault: () => Promise<ApiKeyVault> = SecretVault.openAutomatically,
    private readonly fetchImpl: typeof globalThis.fetch = (...args) => import("@tauri-apps/plugin-http")
      .then(({ fetch }) => fetch(...args)),
    hostedAiConfig?: HostedAiProviderConfig,
    private readonly createLocalEmbedder: () => LocalTextEmbedder = () => new LocalEmbeddingWorkerClient(),
    private readonly takePddCommerceBootstrap: () => Promise<PddCommerceBootstrap | undefined> = async () => undefined,
  ) {
    if (hostedAiConfig) this.setHostedAiConfig(hostedAiConfig);
  }

  get snapshot(): ProviderSessionSnapshot {
    return {
      ...this.snapshotValue,
      profiles: this.snapshotValue.profiles.map((profile) => ({
        ...profile,
        ...(profile.modelContextWindows
          ? { modelContextWindows: { ...profile.modelContextWindows } }
          : {}),
      })),
    };
  }

  getModelContextWindow(providerId?: string, modelId?: string): number {
    const profile = this.snapshotValue.profiles.find((candidate) => candidate.id === providerId)
      ?? this.snapshotValue.profiles.find(
        (candidate) => candidate.id === this.snapshotValue.selectedProviderId,
      );
    return resolveModelContextWindow(profile, modelId ?? profile?.defaultModel);
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  configureHostedAi(config: HostedAiProviderConfig): void {
    this.setHostedAiConfig(config);
    if (this.vault) void this.initializeHostedAi(this.vault);
  }

  async refreshHostedAi(): Promise<ProviderSessionSnapshot> {
    const vault = this.requireVault();
    if (!this.hostedAiConfig) throw new Error("当前构建未启用 NKG AI 服务");
    await this.initializeHostedAi(vault);
    return this.snapshot;
  }

  async purchaseHostedPoints(packId: string): Promise<ProviderSessionSnapshot> {
    const purchases = this.hostedAiConfig?.purchases;
    if (!purchases) throw new Error("AI 点数购买仅在 iOS App Store 版本中可用");
    await purchases.purchase(packId);
    return this.refresh();
  }

  async getHostedRecoveryToken(): Promise<string> {
    if (!this.hostedAiConfig) throw new Error("当前构建未启用 NKG AI 服务");
    return this.hostedAiConfig.session.getOrCreateRecoveryToken();
  }

  async recoverHostedAccount(recoveryToken: string): Promise<ProviderSessionSnapshot> {
    const config = this.hostedAiConfig;
    if (!config) throw new Error("当前构建未启用 NKG AI 服务");
    await config.session.recoverAccount(recoveryToken.trim());
    await config.purchases?.initialize();
    return this.refresh();
  }

  initialize(): Promise<ProviderSessionSnapshot> {
    if (this.vault) return this.refresh();
    this.initialization ??= this.openAndRefresh().finally(() => { this.initialization = undefined; });
    return this.initialization;
  }

  private async openAndRefresh(): Promise<ProviderSessionSnapshot> {
    const vault = await this.openVault();
    this.vault = vault;
    try {
      await this.provisionPddCommerceBootstrap();
      await this.provisionDefaultWebSearch(vault);
      await this.refresh();
      if (this.hostedAiConfig) await this.initializeHostedAi(vault);
      return this.snapshot;
    }
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
    this.hostedAiConfig?.purchases?.lock();
    this.hostedAiConfig?.session.lock();
    this.localEmbedder?.dispose?.();
    this.localEmbedder = undefined;
    this.localEmbeddingBackfills.clear();
    this.notify();
    await vault?.lock();
  }

  async refresh(): Promise<ProviderSessionSnapshot> {
    this.requireVault();
    const [profiles, storedSelection, webSearch, localMemory, memory, commerce] = await Promise.all([
      this.dataStore.list(),
      this.dataStore.getSelectedId(),
      this.dataStore.getWebSearchConfig?.(),
      this.dataStore.getLocalMemoryConfig?.(),
      this.dataStore.getMemoryConfig?.(),
      this.dataStore.getCommerceConfig?.(),
    ]);
    const hostedAi = this.hostedAiConfig?.session.snapshot;
    const hostedPurchases = this.hostedAiConfig?.purchases?.snapshot;
    const hostedProfile = hostedAi?.state === "ready" && hostedAi.account
      ? createHostedProviderProfile(hostedAi.account)
      : undefined;
    const availableProfiles = hostedProfile ? [hostedProfile, ...profiles] : profiles;
    const selectedProviderId = availableProfiles.some((profile) => profile.id === storedSelection)
      ? storedSelection
      : hostedProfile?.id ?? profiles[0]?.id;
    if (selectedProviderId !== storedSelection) {
      await this.dataStore.setSelectedId(selectedProviderId);
    }
    this.snapshotValue = {
      unlocked: true,
      profiles: availableProfiles,
      ...(selectedProviderId ? { selectedProviderId } : {}),
      ...(webSearch ? { webSearch } : {}),
      localMemory: localMemory ?? { ...DEFAULT_LOCAL_MEMORY_CONFIG },
      ...(memory ? { memory } : {}),
      ...(commerce ? { commerce } : {}),
      ...(hostedAi ? { hostedAi } : {}),
      ...(hostedPurchases ? { hostedPurchases } : {}),
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
        modelContextWindows: draft.modelContextWindows,
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
    if (profile.source === "nkg-hosted") throw new Error("NKG AI 是内置模型服务，不能删除");
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

  async createRunOptions(
    options: FlowInvokeOptions = {},
    context: { flowId?: string } = {},
  ): Promise<FlowInvokeOptions> {
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
      throw new Error(`模型“${model}”未在当前模型服务中启用`);
    }
    if (selected.source === "nkg-hosted") {
      const hostedAi = this.hostedAiConfig?.session;
      if (!hostedAi) throw new Error("NKG AI 服务尚未连接");
      const result = await hostedAi.createRunOptions({
        requestId: crypto.randomUUID(),
        flowId: context.flowId ?? "unknown-flow",
        modelId: model,
      }, options);
      const runOptions = context.flowId !== COMPUTER_CONFIG_FLOW_ID
        ? result.options
        : await this.prepareCommerceRunOptions(vault, result.options);
      this.hostedRunAuthorizations.set(runOptions, result.authorization.authorizationId);
      return runOptions;
    }
    const providerOptions = await withProviderEnvironment(selected, vault, options, model);
    if (context.flowId !== COMPUTER_CONFIG_FLOW_ID) return providerOptions;
    return this.prepareCommerceRunOptions(vault, providerOptions);
  }

  async completeRunOptions(options: FlowInvokeOptions): Promise<void> {
    const authorizationId = this.hostedRunAuthorizations.get(options);
    if (!authorizationId) return;
    this.hostedRunAuthorizations.delete(options);
    await this.hostedAiConfig?.session.completeRun(authorizationId);
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

  private async provisionPddCommerceBootstrap(): Promise<void> {
    const bootstrap = await this.takePddCommerceBootstrap();
    if (!bootstrap) return;
    const vault = this.requireVault();
    let clientId = bootstrap.clientId?.trim();
    let clientSecret = bootstrap.clientSecret?.trim();
    let pid = bootstrap.pid?.trim();
    if (bootstrap.authorizationCode && (!clientId || !clientSecret || !pid)) {
      const existing = await this.dataStore.getCommerceConfig?.();
      if (!existing?.pdd) {
        throw new Error("拼多多授权码导入需要已有的本机安全配置");
      }
      this.snapshotValue = { ...this.snapshotValue, commerce: existing };
      const stored = await Promise.all([
        vault.getApiKey(existing.pdd.clientIdRef),
        vault.getApiKey(existing.pdd.clientSecretRef),
      ]);
      clientId ||= stored[0];
      clientSecret ||= stored[1];
      pid ||= existing.pdd.pid;
    }
    if (!clientId || !clientSecret || !pid) {
      throw new Error("拼多多安全初始化缺少 Client ID、Client Secret 或 PID");
    }
    const created = bootstrap.authorizationCode
      ? await createPddAccessToken(
          clientId,
          clientSecret,
          bootstrap.authorizationCode,
          this.fetchImpl,
        )
      : undefined;
    const accessToken = created?.accessToken ?? bootstrap.accessToken;
    if (!accessToken) throw new Error("拼多多安全初始化缺少 Access Token 或授权码");
    await this.saveCommerce({
      provider: "pdd",
      enabled: true,
      key: clientId,
      secret: clientSecret,
      accessToken,
      refreshToken: created?.refreshToken ?? bootstrap.refreshToken ?? "",
      ...(created?.accessTokenExpiresAt
        ? { accessTokenExpiresAt: created.accessTokenExpiresAt }
        : {}),
      ...(created?.refreshTokenExpiresAt
        ? { refreshTokenExpiresAt: created.refreshTokenExpiresAt }
        : {}),
      pid,
    });
  }

  async pingModel(modelId: string, signal?: AbortSignal): Promise<number> {
    const model = modelId.trim();
    if (!model) throw new Error("请选择要检测的模型");
    let options: FlowInvokeOptions | undefined;
    try {
      options = await this.createRunOptions({
        envOverrides: { variables: { LLM_DEFAULT_MODEL: model } },
      }, { flowId: "builtin.model-ping" });
      const baseUrl = options.envOverrides?.variables?.LLM_BASE_URL;
      const apiKey = options.envOverrides?.secrets?.LLM_API_KEY;
      if (typeof baseUrl !== "string" || typeof apiKey !== "string") {
        throw new Error("模型服务授权无效，请重新连接后再试");
      }
      return await pingCompatibleModel(baseUrl, apiKey, model, this.fetchImpl, signal);
    } finally {
      if (options) {
        await this.completeRunOptions(options).catch((cause: unknown) => {
          console.warn("Unable to complete model ping run", cause);
        });
      }
    }
  }

  async saveWebSearch(draft: WebSearchDraft): Promise<ProviderSessionSnapshot> {
    const vault = this.requireVault();
    if (!this.dataStore.setWebSearchConfig) throw new Error("联网搜索配置存储不可用");
    if (isPlainHttpProviderUrl(draft.baseUrl) && draft.allowInsecureHttp !== true) {
      throw new Error(`保存明文 HTTP 搜索服务前必须确认风险。${INSECURE_PROVIDER_WARNING}`);
    }
    if (draft.authMode === "nkg-session") {
      if (!this.hostedAiConfig) throw new Error("当前构建未启用 NKG 默认搜索");
      if (normalizeComparableUrl(draft.baseUrl) !== normalizeComparableUrl(DEFAULT_SEARXNG_URL)) {
        throw new Error("NKG 默认搜索必须使用内置服务地址");
      }
    }
    const apiKeyRef = this.snapshotValue.webSearch?.apiKeyRef ?? WEB_SEARCH_API_KEY_REF;
    const endpointChanged = Boolean(this.snapshotValue.webSearch
      && normalizeComparableUrl(this.snapshotValue.webSearch.baseUrl) !== normalizeComparableUrl(draft.baseUrl));
    const storedKey = await vault.getApiKey(apiKeyRef);
    const previousKey = endpointChanged ? undefined : storedKey;
    const nextKey = draft.apiKey.trim();
    if (draft.authMode === "x-api-key" && !nextKey && !previousKey) {
      throw new Error(endpointChanged ? "更换 SearXNG 服务后请填写该服务的 API Key" : "请填写 SearXNG API Key");
    }
    const vaultChanged = Boolean(nextKey) || (endpointChanged && draft.authMode === "none" && Boolean(storedKey));
    if (nextKey) await vault.setApiKey(apiKeyRef, nextKey);
    else if (endpointChanged && draft.authMode === "none" && storedKey) await vault.removeApiKey(apiKeyRef);
    try {
      await this.dataStore.setWebSearchConfig({
        provider: "searxng",
        baseUrl: draft.baseUrl,
        apiKeyRef,
        authMode: draft.authMode,
        enabled: draft.enabled,
      });
    } catch (error) {
      if (vaultChanged) {
        if (storedKey) await vault.setApiKey(apiKeyRef, storedKey);
        else await vault.removeApiKey(apiKeyRef);
      }
      throw error;
    }
    return this.refresh();
  }

  async testWebSearch(
    draft: WebSearchDraft,
    signal?: AbortSignal,
  ): Promise<WebSearchResult[]> {
    const vault = this.requireVault();
    if (draft.authMode === "nkg-session") {
      const hostedAi = this.hostedAiConfig?.session;
      if (!hostedAi) throw new Error("当前构建未启用 NKG 默认搜索");
      return hostedAi.searchWeb("SearXNG connectivity test", 3, signal);
    }
    if (isPlainHttpProviderUrl(draft.baseUrl) && draft.allowInsecureHttp !== true) {
      throw new Error(`通过明文 HTTP 测试搜索前必须确认风险。${INSECURE_PROVIDER_WARNING}`);
    }
    const current = this.snapshotValue.webSearch;
    const endpointChanged = Boolean(current
      && normalizeComparableUrl(current.baseUrl) !== normalizeComparableUrl(draft.baseUrl));
    const apiKey = draft.apiKey.trim()
      || (!endpointChanged && current ? await vault.getApiKey(current.apiKeyRef) : undefined)
      || "";
    if (draft.authMode === "x-api-key" && !apiKey) throw new Error("请先填写 SearXNG API Key");
    return fetchSearxngResults(
      draft.baseUrl,
      apiKey,
      "SearXNG connectivity test",
      this.fetchImpl,
      { signal, maxResults: 3 },
    );
  }

  async saveLocalMemory(draft: LocalMemoryDraft): Promise<ProviderSessionSnapshot> {
    this.requireVault();
    if (!this.dataStore.setLocalMemoryConfig) throw new Error("本地记忆配置存储不可用");
    if (draft.semanticSearch && draft.embeddingMode === "cloud") {
      this.requireEmbeddingProvider(draft.embeddingProviderId);
    }
    await this.dataStore.setLocalMemoryConfig({
      provider: "local",
      enabled: draft.enabled,
      autoArchive: draft.autoArchive,
      semanticSearch: draft.semanticSearch,
      embeddingMode: draft.embeddingMode,
      embeddingProviderId: draft.embeddingMode === "cloud" ? draft.embeddingProviderId : "",
      embeddingModel: draft.embeddingMode === "local"
        ? LOCAL_EMBEDDING_MODEL_ID
        : draft.embeddingModel,
    });
    return this.refresh();
  }

  async testLocalMemorySemanticSearch(
    draft: LocalMemoryDraft,
    signal?: AbortSignal,
  ): Promise<number> {
    if (draft.embeddingMode === "local") {
      const [vector] = await this.getLocalEmbedder().embed(
        ["本地记忆语义检索连接测试"],
        ["query"],
        signal,
      );
      return vector?.length ?? 0;
    }
    const vault = this.requireVault();
    const profile = this.requireEmbeddingProvider(draft.embeddingProviderId);
    const apiKey = await vault.getApiKey(profile.apiKeyRef);
    if (!apiKey) throw new Error(`模型服务“${profile.name}”的 API Key 不可用`);
    const [vector] = await requestTextEmbeddings(
      profile.baseUrl,
      apiKey,
      draft.embeddingModel,
      ["本地记忆语义检索连接测试"],
      this.fetchImpl,
      signal,
    );
    return vector!.length;
  }

  async searchLocalMemory(
    query: string,
    namespace: string,
    options: { signal?: AbortSignal; limit?: number } = {},
  ): Promise<MemoryItem[]> {
    const config = this.snapshotValue.localMemory ?? DEFAULT_LOCAL_MEMORY_CONFIG;
    if (!config.enabled) return [];
    const fallback = () => listRelevantMemories(query, options.limit ?? 8, namespace);
    if (!config.semanticSearch) return fallback();
    if (config.embeddingMode === "local") {
      const embedder = this.getLocalEmbedder();
      try {
        const results = await searchLocalMemoriesSemantically({
          query,
          namespace,
          limit: options.limit,
          modelKey: LOCAL_EMBEDDING_MODEL_KEY,
          embedTexts: (texts, roles, signal) => embedder.embed(texts, roles, signal),
          maxBackfill: 8,
          signal: options.signal,
        });
        this.scheduleLocalEmbeddingBackfill(namespace, embedder);
        return results;
      } catch (cause: unknown) {
        if (cause instanceof Error && cause.name === "AbortError") throw cause;
        console.warn("本地 BGE 语义检索失败，已回退到词项检索", cause);
        return fallback();
      }
    }
    const profile = this.snapshotValue.profiles.find(
      (candidate) => candidate.id === config.embeddingProviderId && candidate.source !== "nkg-hosted",
    );
    if (!profile) return fallback();
    try {
      const apiKey = await this.requireVault().getApiKey(profile.apiKeyRef);
      if (!apiKey) return fallback();
      return await searchLocalMemoriesSemantically({
        query,
        namespace,
        limit: options.limit,
        modelKey: memoryEmbeddingModelKey(profile, config.embeddingModel),
        embedTexts: (texts, _roles, signal) => requestTextEmbeddings(
          profile.baseUrl,
          apiKey,
          config.embeddingModel,
          texts,
          this.fetchImpl,
          signal,
        ),
        signal: options.signal,
      });
    } catch (cause: unknown) {
      if (cause instanceof Error && cause.name === "AbortError") throw cause;
      console.warn("本地记忆语义检索失败，已回退到词项检索", cause);
      return fallback();
    }
  }

  isLocalMemoryEnabled(): boolean {
    return (this.snapshotValue.localMemory ?? DEFAULT_LOCAL_MEMORY_CONFIG).enabled;
  }

  private getLocalEmbedder(): LocalTextEmbedder {
    this.localEmbedder ??= this.createLocalEmbedder();
    return this.localEmbedder;
  }

  private scheduleLocalEmbeddingBackfill(
    namespace: string,
    embedder: LocalTextEmbedder,
  ): void {
    if (this.localEmbeddingBackfills.has(namespace)) return;
    const task = backfillLocalMemoryEmbeddings({
      namespace,
      modelKey: LOCAL_EMBEDDING_MODEL_KEY,
      embedTexts: (texts, roles, signal) => embedder.embed(texts, roles, signal),
      batchSize: 8,
    }).then(() => undefined).catch((cause: unknown) => {
      console.warn("本地记忆后台向量索引未完成，将在后续检索时继续", cause);
    }).finally(() => {
      if (this.localEmbeddingBackfills.get(namespace) === task) {
        this.localEmbeddingBackfills.delete(namespace);
      }
    });
    this.localEmbeddingBackfills.set(namespace, task);
  }

  async saveMemoryService(draft: MemoryServiceDraft): Promise<ProviderSessionSnapshot> {
    const vault = this.requireVault();
    if (!this.dataStore.setMemoryConfig) throw new Error("记忆服务配置存储不可用");
    if (isPlainHttpProviderUrl(draft.baseUrl) && draft.allowInsecureHttp !== true) {
      throw new Error(`保存明文 HTTP 记忆服务前必须确认风险。${INSECURE_PROVIDER_WARNING}`);
    }
    const apiKeyRef = this.snapshotValue.memory?.apiKeyRef ?? MEMORY_API_KEY_REF;
    const previousKey = await vault.getApiKey(apiKeyRef);
    const nextKey = draft.apiKey.trim();
    if (!nextKey && !previousKey) throw new Error("请填写 MemOS API Key");
    if (nextKey) await vault.setApiKey(apiKeyRef, nextKey);
    try {
      await this.dataStore.setMemoryConfig({
        provider: "memos",
        baseUrl: draft.baseUrl,
        userId: draft.userId,
        apiKeyRef,
        enabled: draft.enabled,
      });
    } catch (error) {
      if (nextKey) await restoreVaultValue(vault, apiKeyRef, previousKey);
      throw error;
    }
    return this.refresh();
  }

  async testMemoryService(draft: MemoryServiceDraft, signal?: AbortSignal): Promise<number> {
    const vault = this.requireVault();
    if (isPlainHttpProviderUrl(draft.baseUrl) && draft.allowInsecureHttp !== true) {
      throw new Error(`通过明文 HTTP 测试记忆服务前必须确认风险。${INSECURE_PROVIDER_WARNING}`);
    }
    const current = this.snapshotValue.memory;
    const apiKeyRef = current?.apiKeyRef ?? MEMORY_API_KEY_REF;
    const apiKey = draft.apiKey.trim() || await vault.getApiKey(apiKeyRef);
    if (!apiKey) throw new Error("请先填写 MemOS API Key");
    return testMemosConnection({
      provider: "memos",
      baseUrl: draft.baseUrl,
      userId: draft.userId,
      apiKeyRef,
      enabled: true,
    }, apiKey, this.fetchImpl, signal);
  }

  async searchMemory(
    query: string,
    conversationId: string,
    options: MemorySearchOptions = {},
  ): Promise<RemoteMemory[]> {
    const vault = this.requireVault();
    const config = this.snapshotValue.memory;
    if (!config?.enabled) return [];
    const apiKey = await vault.getApiKey(config.apiKeyRef);
    if (!apiKey) throw new Error("MemOS API Key 不可用，请在设置中重新保存");
    return searchMemosMemories(config, apiKey, query, conversationId, this.fetchImpl, options);
  }

  async addMemoryTurn(
    conversationId: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    signal?: AbortSignal,
  ): Promise<void> {
    const vault = this.requireVault();
    const config = this.snapshotValue.memory;
    if (!config?.enabled) return;
    const apiKey = await vault.getApiKey(config.apiKeyRef);
    if (!apiKey) throw new Error("MemOS API Key 不可用，请在设置中重新保存");
    await addMemosTurn(config, apiKey, conversationId, messages, this.fetchImpl, signal);
  }

  isMemoryEnabled(): boolean {
    return this.snapshotValue.memory?.enabled === true;
  }

  private requireEmbeddingProvider(providerId: string): ProviderProfile {
    const normalized = providerId.trim();
    const profile = this.snapshotValue.profiles.find((candidate) => candidate.id === normalized);
    if (!profile) throw new Error("请选择一个已配置的 Embedding Provider");
    if (profile.source === "nkg-hosted") {
      throw new Error("NKG AI 暂未开放 Embeddings，请选择自定义 OpenAI 兼容 Provider");
    }
    return profile;
  }

  async saveCommerce(draft: CommerceDraft): Promise<ProviderSessionSnapshot> {
    const vault = this.requireVault();
    if (!this.dataStore.setCommerceConfig) throw new Error("电商返利配置存储不可用");
    const resolved = await this.resolveCommerceDraft(draft, vault);
    const writes = resolved.secretWrites.filter((item) => item.value.trim());
    const previous = new Map<string, string | undefined>();
    for (const item of writes) {
      previous.set(item.reference, await vault.getApiKey(item.reference));
      await vault.setApiKey(item.reference, item.value);
    }
    try {
      await this.dataStore.setCommerceConfig(resolved.config);
    } catch (error) {
      for (const [reference, value] of previous) await restoreVaultValue(vault, reference, value);
      throw error;
    }
    return this.refresh();
  }

  async testCommerce(draft: CommerceDraft, signal?: AbortSignal): Promise<AffiliateProduct[]> {
    const vault = this.requireVault();
    const resolved = await this.resolveCommerceDraft(draft, vault);
    return searchAffiliateProducts(
      resolved.config,
      resolved.credentials,
      { keyword: "RTX 4060 显卡", count: 1 },
      this.fetchImpl,
      { signal },
    );
  }

  async createPddAuthorizationUrl(draft: CommerceDraft, signal?: AbortSignal): Promise<string> {
    const vault = this.requireVault();
    const resolved = await this.resolveCommerceDraft({ ...draft, provider: "pdd" }, vault);
    if (resolved.credentials.provider !== "pdd" || !resolved.config.pdd) {
      throw new Error("拼多多联盟配置不完整");
    }
    return generatePddAuthorizationUrl(
      resolved.config.pdd,
      resolved.credentials,
      this.fetchImpl,
      { signal },
    );
  }

  async searchWeb(
    query: string,
    options: WebSearchQueryOptions = {},
  ): Promise<WebSearchResult[]> {
    const vault = this.requireVault();
    const config = this.snapshotValue.webSearch;
    if (!config?.enabled) throw new Error("联网搜索尚未启用");
    if (config.authMode === "nkg-session") {
      const hostedAi = this.hostedAiConfig?.session;
      if (!hostedAi) throw new Error("NKG 默认搜索当前不可用，请配置自己的 SearXNG");
      return hostedAi.searchWeb(query, Math.max(1, Math.min(10, options.maxResults ?? 6)), options.signal);
    }
    const apiKey = config.authMode === "x-api-key"
      ? await vault.getApiKey(config.apiKeyRef)
      : "";
    if (config.authMode === "x-api-key" && !apiKey) {
      throw new Error("联网搜索 API Key 不可用，请在设置中重新保存");
    }
    return fetchSearxngResults(config.baseUrl, apiKey ?? "", query, this.fetchImpl, options);
  }

  private async provisionDefaultWebSearch(vault: ApiKeyVault): Promise<void> {
    if (!this.dataStore.getWebSearchConfig
      || !this.dataStore.setWebSearchConfig
      || await this.dataStore.getWebSearchConfig()) return;
    const useHostedSession = Boolean(this.hostedAiConfig);
    if (!useHostedSession && !DEFAULT_SEARXNG_API_KEY) return;
    const previousKey = await vault.getApiKey(WEB_SEARCH_API_KEY_REF);
    if (!useHostedSession) {
      await vault.setApiKey(WEB_SEARCH_API_KEY_REF, DEFAULT_SEARXNG_API_KEY);
    }
    try {
      await this.dataStore.setWebSearchConfig({
        provider: "searxng",
        baseUrl: DEFAULT_SEARXNG_URL,
        apiKeyRef: WEB_SEARCH_API_KEY_REF,
        authMode: useHostedSession ? "nkg-session" : "x-api-key",
        enabled: true,
      });
    } catch (cause) {
      if (!useHostedSession) await restoreVaultValue(vault, WEB_SEARCH_API_KEY_REF, previousKey);
      throw cause;
    }
  }

  async generateImage(request: ProviderImageGenerationRequest): Promise<ImageGenerationResult> {
    const vault = this.requireVault();
    const providerId = request.providerId ?? this.snapshotValue.selectedProviderId;
    const profile = this.snapshotValue.profiles.find((candidate) => candidate.id === providerId);
    if (!profile) throw new Error("请先选择一个模型服务");
    if (!profile.enabledModels.includes(request.model)) {
      throw new Error(`模型“${request.model}”未在当前模型服务中启用`);
    }
    if (profile.source === "nkg-hosted") {
      const hostedAi = this.hostedAiConfig?.session;
      if (!hostedAi) throw new Error("NKG AI 服务尚未连接");
      const { options, authorization } = await hostedAi.createRunOptions({
        requestId: crypto.randomUUID(),
        flowId: "builtin.image-generation",
        modelId: request.model,
      });
      const baseUrl = options.envOverrides?.variables?.LLM_BASE_URL;
      const apiKey = options.envOverrides?.secrets?.LLM_API_KEY;
      if (typeof baseUrl !== "string" || typeof apiKey !== "string") {
        throw new Error("NKG AI 生图授权无效");
      }
      try {
        return await requestImageGeneration(baseUrl, apiKey, request, this.fetchImpl);
      } finally {
        await hostedAi.completeRun(authorization.authorizationId).catch((cause: unknown) => {
          console.warn("Unable to complete NKG AI image run", cause);
        });
      }
    }
    const apiKey = await vault.getApiKey(profile.apiKeyRef);
    if (!apiKey) throw new Error(`模型服务“${profile.name}”的 API Key 不可用`);
    return requestImageGeneration(profile.baseUrl, apiKey, request, this.fetchImpl);
  }

  private async resolveCommerceDraft(
    draft: CommerceDraft,
    vault: ApiKeyVault,
  ): Promise<{
    config: AffiliateCommerceConfig;
    credentials: AffiliateCredentials;
    secretWrites: Array<{ reference: string; value: string }>;
  }> {
    const current = this.snapshotValue.commerce;
    if (draft.provider === "jd") {
      const keyRef = current?.jd?.appKeyRef ?? JD_APP_KEY_REF;
      const secretRef = current?.jd?.secretKeyRef ?? JD_SECRET_KEY_REF;
      const appKey = draft.key.trim() || await vault.getApiKey(keyRef);
      const secretKey = draft.secret.trim() || await vault.getApiKey(secretRef);
      if (!appKey || !secretKey) throw new Error("请填写京东联盟 App Key 与 Secret Key");
      return {
        secretWrites: [
          { reference: keyRef, value: draft.key.trim() },
          { reference: secretRef, value: draft.secret.trim() },
        ],
        credentials: { provider: "jd", appKey, secretKey },
        config: {
          enabled: draft.enabled,
          selectedProvider: "jd",
          ...(current?.pdd ? { pdd: current.pdd } : {}),
          jd: {
            appKeyRef: keyRef,
            secretKeyRef: secretRef,
            pid: draft.pid,
            siteId: draft.siteId ?? "",
            positionId: draft.positionId ?? "",
          },
        },
      };
    }
    const keyRef = current?.pdd?.clientIdRef ?? PDD_CLIENT_ID_REF;
    const secretRef = current?.pdd?.clientSecretRef ?? PDD_CLIENT_SECRET_REF;
    const accessTokenRef = current?.pdd?.accessTokenRef ?? PDD_ACCESS_TOKEN_REF;
    const refreshTokenRef = current?.pdd?.refreshTokenRef ?? PDD_REFRESH_TOKEN_REF;
    const clientId = draft.key.trim() || await vault.getApiKey(keyRef);
    const clientSecret = draft.secret.trim() || await vault.getApiKey(secretRef);
    const nextAccessToken = draft.accessToken?.trim() ?? "";
    const nextRefreshToken = draft.refreshToken?.trim() ?? "";
    const accessToken = nextAccessToken || await vault.getApiKey(accessTokenRef);
    const refreshToken = nextRefreshToken || await vault.getApiKey(refreshTokenRef);
    if (!clientId || !clientSecret) throw new Error("请填写拼多多联盟 Client ID 与 Client Secret");
    if (!accessToken) throw new Error("请填写拼多多 OAuth Access Token");
    const accessTokenExpiresAt = draft.accessTokenExpiresAt
      ?? (nextAccessToken ? undefined : current?.pdd?.accessTokenExpiresAt);
    const refreshTokenExpiresAt = draft.refreshTokenExpiresAt
      ?? (nextRefreshToken ? undefined : current?.pdd?.refreshTokenExpiresAt);
    return {
      secretWrites: [
        { reference: keyRef, value: draft.key.trim() },
        { reference: secretRef, value: draft.secret.trim() },
        { reference: accessTokenRef, value: nextAccessToken },
        { reference: refreshTokenRef, value: nextRefreshToken },
      ],
      credentials: { provider: "pdd", clientId, clientSecret, accessToken },
      config: {
        enabled: draft.enabled,
        selectedProvider: "pdd",
        ...(current?.jd ? { jd: current.jd } : {}),
        pdd: {
          clientIdRef: keyRef,
          clientSecretRef: secretRef,
          accessTokenRef,
          ...(refreshToken ? { refreshTokenRef } : {}),
          ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
          ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
          pid: draft.pid,
        },
      },
    };
  }

  private async prepareCommerceRunOptions(
    vault: ApiKeyVault,
    options: FlowInvokeOptions,
  ): Promise<FlowInvokeOptions> {
    let config = this.snapshotValue.commerce;
    if (!config) {
      throw new Error("拼多多联盟凭据尚未完成安全初始化，请重新启动应用后再试");
    }
    if (config?.enabled && config.selectedProvider === "pdd" && config.pdd?.accessTokenExpiresAt) {
      const expiresAt = Date.parse(config.pdd.accessTokenExpiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + PDD_TOKEN_REFRESH_SKEW_MS) {
        if (!config.pdd.refreshTokenRef) {
          throw new Error("拼多多 OAuth Access Token 已过期，请重新授权并保存新的 Token");
        }
        const [clientId, clientSecret, refreshToken] = await Promise.all([
          vault.getApiKey(config.pdd.clientIdRef),
          vault.getApiKey(config.pdd.clientSecretRef),
          vault.getApiKey(config.pdd.refreshTokenRef),
        ]);
        if (!clientId || !clientSecret || !refreshToken) {
          throw new Error("拼多多 OAuth 刷新凭据不可用，请重新授权");
        }
        const refreshed = await refreshPddAccessToken(
          clientId,
          clientSecret,
          refreshToken,
          this.fetchImpl,
        );
        await vault.setApiKey(config.pdd.accessTokenRef, refreshed.accessToken);
        if (refreshed.refreshToken) {
          await vault.setApiKey(config.pdd.refreshTokenRef, refreshed.refreshToken);
        }
        config = {
          ...config,
          pdd: {
            ...config.pdd,
            accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
            ...(refreshed.refreshTokenExpiresAt
              ? { refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt }
              : {}),
          },
        };
        if (!this.dataStore.setCommerceConfig) throw new Error("电商返利配置存储不可用");
        await this.dataStore.setCommerceConfig(config);
        this.snapshotValue = { ...this.snapshotValue, commerce: config };
        this.notify();
      }
    }
    const commerceOptions = await withAffiliateFlowEnvironment(config, vault, options);
    return this.prepareMarketSearchRunOptions(vault, commerceOptions);
  }

  private async prepareMarketSearchRunOptions(
    vault: ApiKeyVault,
    options: FlowInvokeOptions,
  ): Promise<FlowInvokeOptions> {
    const search = this.snapshotValue.webSearch;
    if (!search?.enabled) {
      return {
        ...options,
        envOverrides: {
          variables: {
            ...options.envOverrides?.variables,
            [PUBLIC_MARKET_SEARCH_ENV_KEYS.enabled]: false,
          },
          secrets: { ...options.envOverrides?.secrets },
        },
      };
    }
    if (search.authMode === "nkg-session") {
      const hosted = this.hostedAiConfig;
      if (!hosted) throw new Error("NKG 默认搜索当前不可用");
      return {
        ...options,
        envOverrides: {
          variables: {
            ...options.envOverrides?.variables,
            [PUBLIC_MARKET_SEARCH_ENV_KEYS.enabled]: true,
            [PUBLIC_MARKET_SEARCH_ENV_KEYS.mode]: "nkg-session",
            [PUBLIC_MARKET_SEARCH_ENV_KEYS.baseUrl]: hosted.serviceUrl ?? DEFAULT_HOSTED_AI_SERVICE_URL,
          },
          secrets: {
            ...options.envOverrides?.secrets,
            [PUBLIC_MARKET_SEARCH_ENV_KEYS.sessionToken]: hosted.session.getSearchSessionToken(),
          },
        },
      };
    }
    const apiKey = search.authMode === "x-api-key"
      ? await vault.getApiKey(search.apiKeyRef)
      : "";
    if (search.authMode === "x-api-key" && !apiKey) {
      throw new Error("联网搜索 API Key 不可用，请在设置中重新保存");
    }
    return {
      ...options,
      envOverrides: {
        variables: {
          ...options.envOverrides?.variables,
          [PUBLIC_MARKET_SEARCH_ENV_KEYS.enabled]: true,
          [PUBLIC_MARKET_SEARCH_ENV_KEYS.mode]: "searxng",
          [PUBLIC_MARKET_SEARCH_ENV_KEYS.baseUrl]: search.baseUrl,
        },
        secrets: {
          ...options.envOverrides?.secrets,
          [PUBLIC_MARKET_SEARCH_ENV_KEYS.apiKey]: apiKey ?? "",
        },
      },
    };
  }

  private requireVault(): ApiKeyVault {
    if (!this.vault) throw new Error("Local secret vault is locked");
    return this.vault;
  }

  private setHostedAiConfig(config: HostedAiProviderConfig): void {
    this.unsubscribeHostedAi?.();
    this.unsubscribeHostedPurchases?.();
    this.hostedAiConfig = config;
    this.unsubscribeHostedAi = config.session.subscribe(() => {
      if (!this.vault) return;
      void this.refresh().catch((cause: unknown) => {
        console.warn("Unable to refresh NKG AI provider state", cause);
      });
    });
    this.unsubscribeHostedPurchases = config.purchases?.subscribe(() => {
      if (!this.vault) return;
      void this.refresh().catch((cause: unknown) => {
        console.warn("Unable to refresh Apple point purchase state", cause);
      });
    });
  }

  private async initializeHostedAi(vault: ApiKeyVault): Promise<void> {
    const config = this.hostedAiConfig;
    if (!config) return;
    await config.session.initialize(vault, {
      platform: config.platform,
      appVersion: config.appVersion,
    });
    if (config.session.snapshot.state === "ready") await config.purchases?.initialize();
    await this.refresh();
  }

  private notify(): void {
    for (const subscriber of this.subscribers) subscriber();
  }
}

function createHostedProviderProfile(
  account: NonNullable<HostedAiSessionSnapshot["account"]>,
): ProviderProfile {
  const defaultModel = account.models[0]!.id;
  return {
    id: HOSTED_AI_PROVIDER_ID,
    name: "NKG AI",
    baseUrl: `${DEFAULT_HOSTED_AI_SERVICE_URL}/v1`,
    defaultModel,
    enabledModels: account.models.map((model) => model.id),
    modelContextWindows: Object.fromEntries(
      account.models.map((model) => [model.id, model.contextWindow]),
    ),
    apiKeyRef: HOSTED_AI_SESSION_TOKEN_REF,
    source: "nkg-hosted",
    createdAt: 0,
    updatedAt: Date.parse(account.balance.updatedAt),
  };
}

async function readCommerceCredentials(
  config: AffiliateCommerceConfig,
  vault: ApiKeyVault,
): Promise<AffiliateCredentials> {
  if (config.selectedProvider === "jd") {
    if (!config.jd) throw new Error("京东联盟配置不完整");
    const [appKey, secretKey] = await Promise.all([
      vault.getApiKey(config.jd.appKeyRef),
      vault.getApiKey(config.jd.secretKeyRef),
    ]);
    if (!appKey || !secretKey) throw new Error("京东联盟凭据不可用，请在设置中重新保存");
    return { provider: "jd", appKey, secretKey };
  }
  if (!config.pdd) throw new Error("拼多多联盟配置不完整");
  const [clientId, clientSecret, accessToken] = await Promise.all([
    vault.getApiKey(config.pdd.clientIdRef),
    vault.getApiKey(config.pdd.clientSecretRef),
    vault.getApiKey(config.pdd.accessTokenRef),
  ]);
  if (!clientId || !clientSecret || !accessToken) {
    throw new Error("拼多多联盟 OAuth 凭据不可用，请在设置中重新保存");
  }
  return { provider: "pdd", clientId, clientSecret, accessToken };
}

async function withAffiliateFlowEnvironment(
  config: AffiliateCommerceConfig | undefined,
  vault: ApiKeyVault,
  options: FlowInvokeOptions,
): Promise<FlowInvokeOptions> {
  if (!config?.enabled) {
    return {
      ...options,
      envOverrides: {
        variables: {
          ...options.envOverrides?.variables,
          [AFFILIATE_ENV_KEYS.enabled]: false,
        },
        secrets: { ...options.envOverrides?.secrets },
      },
    };
  }
  const credentials = await readCommerceCredentials(config, vault);
  if (credentials.provider === "jd") {
    if (!config.jd) throw new Error("京东联盟配置不完整");
    return {
      ...options,
      envOverrides: {
        variables: {
          ...options.envOverrides?.variables,
          [AFFILIATE_ENV_KEYS.enabled]: true,
          [AFFILIATE_ENV_KEYS.provider]: "jd",
          [AFFILIATE_ENV_KEYS.jdPid]: config.jd.pid,
          [AFFILIATE_ENV_KEYS.jdSiteId]: config.jd.siteId,
          [AFFILIATE_ENV_KEYS.jdPositionId]: config.jd.positionId,
        },
        secrets: {
          ...options.envOverrides?.secrets,
          [AFFILIATE_ENV_KEYS.jdAppKey]: credentials.appKey,
          [AFFILIATE_ENV_KEYS.jdSecretKey]: credentials.secretKey,
        },
      },
    };
  }
  if (!config.pdd) throw new Error("拼多多联盟配置不完整");
  return {
    ...options,
    envOverrides: {
      variables: {
        ...options.envOverrides?.variables,
        [AFFILIATE_ENV_KEYS.enabled]: true,
        [AFFILIATE_ENV_KEYS.provider]: "pdd",
        [AFFILIATE_ENV_KEYS.pddPid]: config.pdd.pid,
      },
      secrets: {
        ...options.envOverrides?.secrets,
        [AFFILIATE_ENV_KEYS.pddClientId]: credentials.clientId,
        [AFFILIATE_ENV_KEYS.pddClientSecret]: credentials.clientSecret,
        [AFFILIATE_ENV_KEYS.pddAccessToken]: credentials.accessToken,
      },
    },
  };
}

async function restoreVaultValue(
  vault: ApiKeyVault,
  reference: string,
  value: string | undefined,
): Promise<void> {
  if (value) await vault.setApiKey(reference, value);
  else await vault.removeApiKey(reference);
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

export async function pingCompatibleModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<number> {
  const endpoint = new URL(baseUrl.trim());
  if (!["http:", "https:"].includes(endpoint.protocol)) {
    throw new Error("API URL 必须使用 HTTP 或 HTTPS");
  }

  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/chat/completions`;
  endpoint.search = "";
  endpoint.hash = "";
  const startedAt = Date.now();
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model.trim(),
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    }),
    signal,
  });
  if (!response.ok) {
    const detail = await readCompatibleError(response);
    throw new Error(`Ping 失败：HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
  }
  return Math.max(1, Date.now() - startedAt);
}

async function readCompatibleError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== "object") return "";
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error.trim().slice(0, 160);
    if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
      return (error as { message: string }).message.trim().slice(0, 160);
    }
    if (typeof (payload as { message?: unknown }).message === "string") {
      return (payload as { message: string }).message.trim().slice(0, 160);
    }
  } catch {
    // Some compatible gateways return an empty or non-JSON error body.
  }
  return "";
}

export async function fetchSearxngResults(
  baseUrl: string,
  apiKey: string,
  query: string,
  fetchImpl: typeof globalThis.fetch,
  options: WebSearchQueryOptions = {},
): Promise<WebSearchResult[]> {
  const normalizedQuery = query.trim().slice(0, 500);
  if (!normalizedQuery) throw new Error("联网搜索关键词不能为空");
  const endpoint = new URL(baseUrl.trim());
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error("SearXNG URL 必须使用 HTTP 或 HTTPS");
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/search`;
  endpoint.search = "";
  endpoint.searchParams.set("q", normalizedQuery);
  endpoint.searchParams.set("format", "json");
  endpoint.hash = "";
  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: {
      ...(apiKey.trim() ? { "X-API-Key": apiKey.trim() } : {}),
      Accept: "application/json",
    },
    signal: options.signal,
  });
  if (!response.ok) {
    const detail = response.status === 401 ? "，请检查 API Key" : "";
    throw new Error(`SearXNG 搜索失败：HTTP ${response.status}${detail}`);
  }
  const payload = await response.json() as unknown;
  const rows = payload && typeof payload === "object"
    && Array.isArray((payload as { results?: unknown }).results)
    ? (payload as { results: unknown[] }).results
    : [];
  const maxResults = Math.max(1, Math.min(10, options.maxResults ?? 6));
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const candidate = row as { title?: unknown; url?: unknown; content?: unknown; engine?: unknown };
    if (typeof candidate.title !== "string" || typeof candidate.url !== "string") continue;
    let resultUrl: URL;
    try { resultUrl = new URL(candidate.url); } catch { continue; }
    if (!['http:', 'https:'].includes(resultUrl.protocol) || seen.has(resultUrl.href)) continue;
    seen.add(resultUrl.href);
    results.push({
      title: candidate.title.trim() || resultUrl.hostname,
      url: resultUrl.href,
      content: typeof candidate.content === "string" ? candidate.content.trim() : "",
      ...(typeof candidate.engine === "string" && candidate.engine.trim()
        ? { engine: candidate.engine.trim() }
        : {}),
    });
    if (results.length >= maxResults) break;
  }
  if (!results.length) throw new Error("SearXNG 返回成功，但没有可用的搜索结果");
  return results;
}

export const providerSession = new ProviderSession(
  sqliteProviderStore,
  SecretVault.openAutomatically,
  (...args) => import("@tauri-apps/plugin-http").then(({ fetch }) => fetch(...args)),
  undefined,
  () => new LocalEmbeddingWorkerClient(),
  () => invoke<PddCommerceBootstrap | undefined>("take_pdd_commerce_bootstrap"),
);

function normalizeComparableUrl(value: string): string {
  try {
    return new URL(value.trim()).toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}
