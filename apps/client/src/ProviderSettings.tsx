import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  DEFAULT_SEARXNG_URL,
  providerSession,
  type CommerceDraft,
  type ProviderDraft,
  type ProviderSessionSnapshot,
  type MemoryServiceDraft,
  type WebSearchDraft,
} from "./providerSession";
import { DEFAULT_MEMOS_URL } from "./memoryGateway";
import { INSECURE_PROVIDER_WARNING, isPlainHttpProviderUrl } from "./providerSecurity";

const EMPTY_DRAFT: ProviderDraft = {
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  defaultModel: "",
  enabledModels: [],
  apiKey: "",
};

const EMPTY_SEARCH_DRAFT: WebSearchDraft = {
  baseUrl: DEFAULT_SEARXNG_URL,
  apiKey: "",
  enabled: true,
};

const EMPTY_MEMORY_DRAFT: MemoryServiceDraft = {
  baseUrl: DEFAULT_MEMOS_URL,
  userId: "",
  apiKey: "",
  enabled: false,
};

const EMPTY_COMMERCE_DRAFT: CommerceDraft = {
  provider: "jd",
  enabled: false,
  key: "",
  secret: "",
  pid: "",
  siteId: "",
  positionId: "",
};

type SettingsSection = "models" | "search" | "memory" | "commerce";

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  description: string;
}> = [
  { id: "models", label: "模型服务", description: "API 与可用模型" },
  { id: "search", label: "联网搜索", description: "SearXNG 服务" },
  { id: "memory", label: "长期记忆", description: "MemOS 服务" },
  { id: "commerce", label: "商品推荐", description: "联盟与返利" },
];

export function ProviderSettings({ onClose }: { onClose: () => void }) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("models");
  const [snapshot, setSnapshot] = useState<ProviderSessionSnapshot>(providerSession.snapshot);
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [searchDraft, setSearchDraft] = useState<WebSearchDraft>(EMPTY_SEARCH_DRAFT);
  const [memoryDraft, setMemoryDraft] = useState<MemoryServiceDraft>(EMPTY_MEMORY_DRAFT);
  const [commerceDraft, setCommerceDraft] = useState<CommerceDraft>(EMPTY_COMMERCE_DRAFT);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [modelQuery, setModelQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [commerceBusy, setCommerceBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [showApiKey, setShowApiKey] = useState(false);
  const [showSearchApiKey, setShowSearchApiKey] = useState(false);
  const [showMemoryApiKey, setShowMemoryApiKey] = useState(false);
  const [showCommerceSecrets, setShowCommerceSecrets] = useState(false);
  const [insecureHttpConfirmed, setInsecureHttpConfirmed] = useState(false);
  const [insecureSearchHttpConfirmed, setInsecureSearchHttpConfirmed] = useState(false);
  const [insecureMemoryHttpConfirmed, setInsecureMemoryHttpConfirmed] = useState(false);
  const insecureDraft = isPlainHttpProviderUrl(draft.baseUrl);
  const insecureSearchDraft = isPlainHttpProviderUrl(searchDraft.baseUrl);
  const insecureMemoryDraft = isPlainHttpProviderUrl(memoryDraft.baseUrl);
  const selected = snapshot.profiles.find((profile) => profile.id === snapshot.selectedProviderId)
    ?? snapshot.profiles[0];
  const availableModels = useMemo(
    () => [...new Set([...discoveredModels, ...draft.enabledModels])]
      .filter((model) => model.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase()))
      .sort((left, right) => left.localeCompare(right)),
    [discoveredModels, draft.enabledModels, modelQuery],
  );

  useEffect(() => {
    let active = true;
    const sync = () => { if (active) setSnapshot(providerSession.snapshot); };
    const unsubscribe = providerSession.subscribe(sync);
    providerSession.initialize()
      .then(sync)
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setInitializing(false); });
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!selected) return;
    setDraft({
      id: selected.id,
      name: "OpenAI",
      baseUrl: selected.baseUrl,
      defaultModel: selected.defaultModel,
      enabledModels: selected.enabledModels,
      apiKey: "",
    });
    setDiscoveredModels(selected.enabledModels);
  }, [selected?.id, selected?.baseUrl, selected?.defaultModel, selected?.enabledModels]);

  useEffect(() => {
    setSearchDraft({
      baseUrl: snapshot.webSearch?.baseUrl ?? DEFAULT_SEARXNG_URL,
      apiKey: "",
      enabled: snapshot.webSearch?.enabled ?? true,
    });
  }, [snapshot.webSearch?.baseUrl, snapshot.webSearch?.enabled]);

  useEffect(() => {
    setMemoryDraft({
      baseUrl: snapshot.memory?.baseUrl ?? DEFAULT_MEMOS_URL,
      userId: snapshot.memory?.userId ?? "",
      apiKey: "",
      enabled: snapshot.memory?.enabled ?? false,
    });
  }, [snapshot.memory?.baseUrl, snapshot.memory?.userId, snapshot.memory?.enabled]);

  useEffect(() => {
    setCommerceDraft(commerceDraftFromSnapshot(snapshot));
  }, [snapshot.commerce]);

  async function perform(
    action: () => Promise<ProviderSessionSnapshot>,
    message?: string,
  ): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setSnapshot(await action());
      if (message) setNotice(message);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function fetchModels() {
    setFetchingModels(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const models = await providerSession.discoverModels({
        ...draft,
        ...(insecureDraft ? { allowInsecureHttp: insecureHttpConfirmed } : {}),
      });
      setDiscoveredModels(models);
      setNotice(`已获取 ${models.length} 个模型，请勾选要在对话中使用的模型`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFetchingModels(false);
    }
  }

  async function testSearch() {
    setSearchBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const results = await providerSession.testWebSearch({
        ...searchDraft,
        ...(insecureSearchDraft ? { allowInsecureHttp: insecureSearchHttpConfirmed } : {}),
      });
      setNotice(`联网搜索连接成功，测试查询返回 ${results.length} 条结果`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSearchBusy(false);
    }
  }

  async function saveSearch() {
    setSearchBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setSnapshot(await providerSession.saveWebSearch({
        ...searchDraft,
        ...(insecureSearchDraft ? { allowInsecureHttp: insecureSearchHttpConfirmed } : {}),
      }));
      setSearchDraft((current) => ({ ...current, apiKey: "" }));
      setInsecureSearchHttpConfirmed(false);
      setNotice("SearXNG 配置已保存在本机，API Key 已加密存储");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSearchBusy(false);
    }
  }

  async function testMemory() {
    setMemoryBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const count = await providerSession.testMemoryService({
        ...memoryDraft,
        ...(insecureMemoryDraft ? { allowInsecureHttp: insecureMemoryHttpConfirmed } : {}),
      });
      setNotice(`MemOS 连接成功${count > 0 ? `，召回 ${count} 条测试记忆` : ""}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMemoryBusy(false);
    }
  }

  async function saveMemory() {
    setMemoryBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setSnapshot(await providerSession.saveMemoryService({
        ...memoryDraft,
        ...(insecureMemoryDraft ? { allowInsecureHttp: insecureMemoryHttpConfirmed } : {}),
      }));
      setMemoryDraft((current) => ({ ...current, apiKey: "" }));
      setInsecureMemoryHttpConfirmed(false);
      setNotice("MemOS 记忆配置已保存，API Key 已进入本机加密存储");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMemoryBusy(false);
    }
  }

  async function testCommerce() {
    setCommerceBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const products = await providerSession.testCommerce(commerceDraft);
      setNotice(products.length > 0
        ? `${commerceDraft.provider === "jd" ? "京东" : "拼多多"}联盟连接成功，已生成测试推广链接`
        : "联盟接口连接成功，但测试关键词没有返回匹配商品");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCommerceBusy(false);
    }
  }

  async function saveCommerce() {
    setCommerceBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setSnapshot(await providerSession.saveCommerce(commerceDraft));
      setCommerceDraft((current) => ({ ...current, key: "", secret: "" }));
      setNotice("电商返利配置已保存；联盟凭据已进入本机加密存储");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCommerceBusy(false);
    }
  }

  function selectCommerceProvider(provider: "jd" | "pdd") {
    setCommerceDraft(commerceDraftFromSnapshot(snapshot, provider));
  }

  function toggleModel(model: string, enabled: boolean) {
    setDraft((current) => {
      const enabledModels = enabled
        ? [...new Set([...current.enabledModels, model])].sort((left, right) => left.localeCompare(right))
        : current.enabledModels.filter((candidate) => candidate !== model);
      const defaultModel = enabledModels.includes(current.defaultModel)
        ? current.defaultModel
        : enabledModels[0] ?? "";
      return { ...current, enabledModels, defaultModel };
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const saved = await perform(
      () => providerSession.save({
        ...draft,
        id: draft.id ?? "openai",
        name: "OpenAI",
        ...(insecureDraft ? { allowInsecureHttp: insecureHttpConfirmed } : {}),
      }),
      "连接和模型配置已保存在本机",
    );
    if (saved) {
      setDraft((current) => ({ ...current, apiKey: "" }));
      setInsecureHttpConfirmed(false);
    }
  }

  const invalidModels = draft.enabledModels.length === 0 || !draft.enabledModels.includes(draft.defaultModel);
  const activeSectionMeta = SETTINGS_SECTIONS.find((section) => section.id === activeSection)!;

  return (
    <div className="settings-content settings-content-split">
      <aside className="settings-sidebar">
        <div className="settings-sidebar-heading">
          <span className="settings-sidebar-mark">N</span>
          <div><strong>设置</strong><small>偏好与服务</small></div>
        </div>
        <nav aria-label="设置分类" className="settings-nav" role="tablist">
          {SETTINGS_SECTIONS.map((section) => (
            <button
              aria-controls="settings-active-panel"
              aria-selected={activeSection === section.id}
              className={activeSection === section.id ? "active" : ""}
              key={section.id}
              role="tab"
              type="button"
              onClick={() => setActiveSection(section.id)}
            >
              <SettingsNavIcon section={section.id} />
              <span><strong>{section.label}</strong><small>{section.description}</small></span>
            </button>
          ))}
        </nav>
        <p className="settings-sidebar-note"><DeviceKeyIcon />凭据仅加密保存在本机</p>
      </aside>

      <section className="settings-main" id="settings-active-panel" role="tabpanel">
      <header className="settings-header settings-panel-header">
        <div>
          <span className="settings-kicker">PREFERENCES</span>
          <h2>{activeSectionMeta.label}</h2>
          <p>{activeSectionMeta.description}</p>
        </div>
        <button aria-label="关闭设置" className="icon-button" type="button" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>

      <div className="settings-panel-scroll" key={activeSection}>

      {initializing || !snapshot.unlocked ? (
        <section className="vault-unlock">
          <span className="vault-icon"><DeviceKeyIcon /></span>
          <h3>{initializing ? "正在准备本地安全存储" : "本地安全存储不可用"}</h3>
          <p>应用会自动生成设备密钥并加密保存 API Key，无需设置或记住额外密码。</p>
          {!initializing ? <button className="primary-button wide" type="button" onClick={() => window.location.reload()}>重新尝试</button> : null}
          {error ? <p className="form-message error" role="alert">{error}</p> : null}
        </section>
      ) : (
        <>
        {activeSection === "models" ? (
        <form className="openai-form" onSubmit={save}>
          <div className="connection-status">
            <span className="openai-mark">AI</span>
            <div><strong>OpenAI Compatible</strong><small>{selected ? `${selected.enabledModels.length} 个模型已启用` : "等待完成配置"}</small></div>
            <span className={`connection-dot ${selected ? "online" : ""}`} />
          </div>

          <label htmlFor="openai-url">API URL</label>
          <input
            id="openai-url"
            placeholder="https://api.openai.com/v1"
            required
            type="url"
            value={draft.baseUrl}
            onChange={(event) => {
              setDraft({ ...draft, baseUrl: event.currentTarget.value });
              setInsecureHttpConfirmed(false);
            }}
          />
          <p className="field-hint">需要包含版本路径，例如 <code>/v1</code>。</p>

          <label htmlFor="openai-key">API Key</label>
          <div className="secret-input">
            <input
              autoComplete="off"
              id="openai-key"
              placeholder={draft.id ? "留空表示保留当前密钥" : "sk-..."}
              required={!draft.id}
              type={showApiKey ? "text" : "password"}
              value={draft.apiKey}
              onChange={(event) => setDraft({ ...draft, apiKey: event.currentTarget.value })}
            />
            <button aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"} type="button" onClick={() => setShowApiKey((value) => !value)}>
              {showApiKey ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
          <p className="field-hint">由应用自动生成的设备密钥加密保存，不需要手动解锁。</p>

          <div className="model-field-heading">
            <div><strong>可用模型</strong><small>获取后手动选择允许在对话中使用的模型</small></div>
            <button className="ghost-button model-fetch-button" disabled={fetchingModels || busy} type="button" onClick={() => void fetchModels()}>
              {fetchingModels ? "正在获取…" : "获取所有模型"}
            </button>
          </div>

          {discoveredModels.length > 0 ? (
            <div className="model-catalog">
              <input aria-label="搜索模型" className="model-search" placeholder="搜索模型" value={modelQuery} onChange={(event) => setModelQuery(event.currentTarget.value)} />
              <div className="model-options">
                {availableModels.map((model) => (
                  <label className="model-option" key={model}>
                    <input checked={draft.enabledModels.includes(model)} type="checkbox" onChange={(event) => toggleModel(model, event.currentTarget.checked)} />
                    <span>{model}</span>
                  </label>
                ))}
                {availableModels.length === 0 ? <p className="model-empty">没有匹配的模型</p> : null}
              </div>
            </div>
          ) : <p className="model-empty">填写 URL 和 API Key，然后获取模型列表。</p>}

          <label htmlFor="openai-model">默认模型</label>
          <select id="openai-model" required value={draft.defaultModel} onChange={(event) => setDraft({ ...draft, defaultModel: event.currentTarget.value })}>
            {draft.enabledModels.length === 0 ? <option value="">请先选择至少一个模型</option> : null}
            {draft.enabledModels.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>

          {insecureDraft ? (
            <label className="security-warning">
              <input checked={insecureHttpConfirmed} type="checkbox" onChange={(event) => setInsecureHttpConfirmed(event.currentTarget.checked)} />
              <span><strong>确认使用明文 HTTP</strong><small>{INSECURE_PROVIDER_WARNING}</small></span>
            </label>
          ) : null}

          {invalidModels ? <p className="form-message error" role="alert">请至少启用一个模型，并选择默认模型。</p> : null}
          <div className="settings-actions">
            <span className="device-key-note">设备密钥由应用自动管理</span>
            <button className="primary-button" disabled={busy || invalidModels || (insecureDraft && !insecureHttpConfirmed)} type="submit">
              {busy ? "正在保存…" : "保存模型设置"}
            </button>
          </div>
        </form>
        ) : null}

        {activeSection === "search" ? (
        <form className="openai-form search-form" onSubmit={(event) => { event.preventDefault(); void saveSearch(); }}>
          <div className="settings-section-heading">
            <div><strong>联网搜索</strong><small>通过自建 SearXNG 为本轮回答补充最新资料与来源</small></div>
            <span className={`connection-dot ${snapshot.webSearch?.enabled ? "online" : ""}`} />
          </div>

          <label htmlFor="searxng-url">SearXNG URL</label>
          <input
            id="searxng-url"
            placeholder={DEFAULT_SEARXNG_URL}
            required
            type="url"
            value={searchDraft.baseUrl}
            onChange={(event) => {
              setSearchDraft({ ...searchDraft, baseUrl: event.currentTarget.value });
              setInsecureSearchHttpConfirmed(false);
            }}
          />
          <p className="field-hint">应用会调用 <code>/search?format=json</code>，请求通过跨平台原生 HTTP 传输。</p>

          <label htmlFor="searxng-key">API Key</label>
          <div className="secret-input">
            <input
              autoComplete="off"
              id="searxng-key"
              placeholder={snapshot.webSearch ? "留空表示保留当前密钥" : "输入 API Key"}
              required={!snapshot.webSearch}
              type={showSearchApiKey ? "text" : "password"}
              value={searchDraft.apiKey}
              onChange={(event) => setSearchDraft({ ...searchDraft, apiKey: event.currentTarget.value })}
            />
            <button aria-label={showSearchApiKey ? "隐藏搜索 API Key" : "显示搜索 API Key"} type="button" onClick={() => setShowSearchApiKey((value) => !value)}>
              {showSearchApiKey ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
          <p className="field-hint">使用 <code>X-API-Key</code> 请求头；密钥只保存在本机 Stronghold。</p>

          <label className="search-enabled-option">
            <input checked={searchDraft.enabled} type="checkbox" onChange={(event) => setSearchDraft({ ...searchDraft, enabled: event.currentTarget.checked })} />
            <span><strong>允许在对话中使用联网搜索</strong><small>对话框中的“联网”按钮可控制每次请求是否搜索。</small></span>
          </label>

          {insecureSearchDraft ? (
            <label className="security-warning">
              <input checked={insecureSearchHttpConfirmed} type="checkbox" onChange={(event) => setInsecureSearchHttpConfirmed(event.currentTarget.checked)} />
              <span><strong>确认搜索服务使用明文 HTTP</strong><small>{INSECURE_PROVIDER_WARNING}</small></span>
            </label>
          ) : null}

          <div className="settings-actions">
            <button className="ghost-button" disabled={searchBusy || (insecureSearchDraft && !insecureSearchHttpConfirmed)} type="button" onClick={() => void testSearch()}>
              {searchBusy ? "正在连接…" : "测试连接"}
            </button>
            <button className="primary-button" disabled={searchBusy || (insecureSearchDraft && !insecureSearchHttpConfirmed)} type="submit">
              {searchBusy ? "正在保存…" : "保存联网设置"}
            </button>
          </div>
        </form>
        ) : null}

        {activeSection === "memory" ? (
        <form className="openai-form search-form" onSubmit={(event) => { event.preventDefault(); void saveMemory(); }}>
          <div className="settings-section-heading">
            <div><strong>跨端长期记忆</strong><small>通过 MemOS 在回答前召回、完整回答后写入</small></div>
            <span className={`connection-dot ${snapshot.memory?.enabled ? "online" : ""}`} />
          </div>

          <label htmlFor="memos-url">MemOS API URL</label>
          <input
            id="memos-url"
            placeholder={DEFAULT_MEMOS_URL}
            required
            type="url"
            value={memoryDraft.baseUrl}
            onChange={(event) => {
              setMemoryDraft({ ...memoryDraft, baseUrl: event.currentTarget.value });
              setInsecureMemoryHttpConfirmed(false);
            }}
          />
          <p className="field-hint">云服务默认使用 <code>/api/openmem/v1</code>；请求通过跨平台原生 HTTP 传输。</p>

          <label htmlFor="memos-user-id">用户标识</label>
          <input
            id="memos-user-id"
            maxLength={256}
            placeholder="同一用户在所有设备上保持一致"
            required
            value={memoryDraft.userId}
            onChange={(event) => setMemoryDraft({ ...memoryDraft, userId: event.currentTarget.value })}
          />
          <p className="field-hint">建议使用账号系统中的稳定 ID，不要填写邮箱、手机号等明文个人信息。</p>

          <label htmlFor="memos-key">MemOS API Key</label>
          <div className="secret-input">
            <input
              autoComplete="off"
              id="memos-key"
              placeholder={snapshot.memory ? "留空表示保留当前密钥" : "mpg-..."}
              required={!snapshot.memory}
              type={showMemoryApiKey ? "text" : "password"}
              value={memoryDraft.apiKey}
              onChange={(event) => setMemoryDraft({ ...memoryDraft, apiKey: event.currentTarget.value })}
            />
            <button aria-label={showMemoryApiKey ? "隐藏 MemOS API Key" : "显示 MemOS API Key"} type="button" onClick={() => setShowMemoryApiKey((value) => !value)}>
              {showMemoryApiKey ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
          <p className="field-hint">使用 <code>Authorization: Token</code>；密钥只保存在本机 Stronghold。</p>

          <label className="search-enabled-option">
            <input checked={memoryDraft.enabled} type="checkbox" onChange={(event) => setMemoryDraft({ ...memoryDraft, enabled: event.currentTarget.checked })} />
            <span><strong>启用 MemOS 长期记忆</strong><small>远程召回失败时继续使用本地已批准记忆，不阻断聊天。</small></span>
          </label>

          {insecureMemoryDraft ? (
            <label className="security-warning">
              <input checked={insecureMemoryHttpConfirmed} type="checkbox" onChange={(event) => setInsecureMemoryHttpConfirmed(event.currentTarget.checked)} />
              <span><strong>确认记忆服务使用明文 HTTP</strong><small>{INSECURE_PROVIDER_WARNING}</small></span>
            </label>
          ) : null}

          <div className="settings-actions">
            <button className="ghost-button" disabled={memoryBusy || !memoryDraft.userId.trim() || (insecureMemoryDraft && !insecureMemoryHttpConfirmed)} type="button" onClick={() => void testMemory()}>
              {memoryBusy ? "正在连接…" : "测试连接"}
            </button>
            <button className="primary-button" disabled={memoryBusy || !memoryDraft.userId.trim() || (insecureMemoryDraft && !insecureMemoryHttpConfirmed)} type="submit">
              {memoryBusy ? "正在保存…" : "保存记忆设置"}
            </button>
          </div>
        </form>
        ) : null}

        {activeSection === "commerce" ? (
        <form className="openai-form search-form" onSubmit={(event) => { event.preventDefault(); void saveCommerce(); }}>
          <div className="settings-section-heading">
            <div><strong>商品推荐与返利</strong><small>查询真实商品并生成京东或拼多多联盟推广链接</small></div>
            <span className={`connection-dot ${snapshot.commerce?.enabled ? "online" : ""}`} />
          </div>

          <label htmlFor="commerce-provider">联盟平台</label>
          <select id="commerce-provider" value={commerceDraft.provider} onChange={(event) => selectCommerceProvider(event.currentTarget.value as "jd" | "pdd")}>
            <option value="jd">京东联盟</option>
            <option value="pdd">拼多多联盟</option>
          </select>

          <label htmlFor="commerce-key">{commerceDraft.provider === "jd" ? "App Key" : "Client ID"}</label>
          <div className="secret-input">
            <input
              autoComplete="off"
              id="commerce-key"
              placeholder={snapshot.commerce?.[commerceDraft.provider] ? "留空表示保留当前凭据" : "输入联盟应用标识"}
              required={!snapshot.commerce?.[commerceDraft.provider]}
              type={showCommerceSecrets ? "text" : "password"}
              value={commerceDraft.key}
              onChange={(event) => setCommerceDraft({ ...commerceDraft, key: event.currentTarget.value })}
            />
            <button aria-label={showCommerceSecrets ? "隐藏联盟凭据" : "显示联盟凭据"} type="button" onClick={() => setShowCommerceSecrets((value) => !value)}>
              {showCommerceSecrets ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>

          <label htmlFor="commerce-secret">{commerceDraft.provider === "jd" ? "Secret Key" : "Client Secret"}</label>
          <div className="secret-input">
            <input
              autoComplete="off"
              id="commerce-secret"
              placeholder={snapshot.commerce?.[commerceDraft.provider] ? "留空表示保留当前密钥" : "输入联盟应用密钥"}
              required={!snapshot.commerce?.[commerceDraft.provider]}
              type={showCommerceSecrets ? "text" : "password"}
              value={commerceDraft.secret}
              onChange={(event) => setCommerceDraft({ ...commerceDraft, secret: event.currentTarget.value })}
            />
          </div>
          <p className="field-hint">应用标识与密钥均由 Stronghold 加密保存，不写入 Flow、SQLite 或日志。</p>

          <label htmlFor="commerce-pid">推广位 PID</label>
          <input id="commerce-pid" required value={commerceDraft.pid} onChange={(event) => setCommerceDraft({ ...commerceDraft, pid: event.currentTarget.value })} />

          {commerceDraft.provider === "jd" ? (
            <>
              <label htmlFor="commerce-site-id">网站/APP ID</label>
              <input id="commerce-site-id" inputMode="numeric" pattern="[0-9]+" required value={commerceDraft.siteId ?? ""} onChange={(event) => setCommerceDraft({ ...commerceDraft, siteId: event.currentTarget.value })} />
              <label htmlFor="commerce-position-id">推广位 ID</label>
              <input id="commerce-position-id" inputMode="numeric" pattern="[0-9]+" required value={commerceDraft.positionId ?? ""} onChange={(event) => setCommerceDraft({ ...commerceDraft, positionId: event.currentTarget.value })} />
            </>
          ) : null}

          <label className="search-enabled-option">
            <input checked={commerceDraft.enabled} type="checkbox" onChange={(event) => setCommerceDraft({ ...commerceDraft, enabled: event.currentTarget.checked })} />
            <span><strong>为电脑配置顾问启用联盟商品推荐</strong><small>模型先确定技术方案，再按匹配度和质量选择商品；不会按佣金高低排序。</small></span>
          </label>
          <p className="field-hint">对用户展示的购买链接会明确标注为推广链接；价格、库存和优惠以下单页为准。</p>

          <div className="settings-actions">
            <button className="ghost-button" disabled={commerceBusy} type="button" onClick={() => void testCommerce()}>
              {commerceBusy ? "正在查询…" : "测试商品与转链"}
            </button>
            <button className="primary-button" disabled={commerceBusy} type="submit">
              {commerceBusy ? "正在保存…" : "保存返利设置"}
            </button>
          </div>
        </form>
        ) : null}
        {notice ? <p className="form-message success settings-global-message" role="status">{notice}</p> : null}
        {error ? <p className="form-message error settings-global-message" role="alert">{error}</p> : null}
        </>
      )}
      </div>
      </section>
    </div>
  );
}

function commerceDraftFromSnapshot(
  snapshot: ProviderSessionSnapshot,
  provider = snapshot.commerce?.selectedProvider ?? "jd",
): CommerceDraft {
  if (provider === "jd") {
    return {
      provider,
      enabled: snapshot.commerce?.enabled ?? false,
      key: "",
      secret: "",
      pid: snapshot.commerce?.jd?.pid ?? "",
      siteId: snapshot.commerce?.jd?.siteId ?? "",
      positionId: snapshot.commerce?.jd?.positionId ?? "",
    };
  }
  return {
    provider,
    enabled: snapshot.commerce?.enabled ?? false,
    key: "",
    secret: "",
    pid: snapshot.commerce?.pdd?.pid ?? "",
  };
}

function CloseIcon() { return <svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>; }
function SettingsNavIcon({ section }: { section: SettingsSection }) {
  if (section === "models") return <svg viewBox="0 0 24 24"><rect height="14" rx="2" width="18" x="3" y="5" /><path d="M7 9h10M7 13h6" /></svg>;
  if (section === "search") return <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4M8 11h6M11 8v6" /></svg>;
  if (section === "memory") return <svg viewBox="0 0 24 24"><path d="M7 4h10v16H7zM10 8h4M10 12h4" /></svg>;
  return <svg viewBox="0 0 24 24"><path d="M4 7h16l-1 12H5L4 7ZM8 7a4 4 0 0 1 8 0" /></svg>;
}
function DeviceKeyIcon() { return <svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg>; }
function EyeIcon() { return <svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>; }
function EyeOffIcon() { return <svg viewBox="0 0 24 24"><path d="m3 3 18 18M10.6 6.2A9.8 9.8 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-2.1 2.8M6.2 6.2C3.8 8 2.5 12 2.5 12s3.5 6 9.5 6a9 9 0 0 0 3-.5" /></svg>; }
