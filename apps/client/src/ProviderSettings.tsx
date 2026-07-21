import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  providerSession,
  type ProviderDraft,
  type ProviderSessionSnapshot,
} from "./providerSession";
import { INSECURE_PROVIDER_WARNING, isPlainHttpProviderUrl } from "./providerSecurity";

const EMPTY_DRAFT: ProviderDraft = {
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  defaultModel: "",
  enabledModels: [],
  apiKey: "",
};

export function ProviderSettings({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<ProviderSessionSnapshot>(providerSession.snapshot);
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [modelQuery, setModelQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [showApiKey, setShowApiKey] = useState(false);
  const [insecureHttpConfirmed, setInsecureHttpConfirmed] = useState(false);
  const insecureDraft = isPlainHttpProviderUrl(draft.baseUrl);
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

  return (
    <div className="settings-content">
      <header className="settings-header">
        <div>
          <span className="settings-kicker">MODEL PROVIDER</span>
          <h2>OpenAI 设置</h2>
          <p>连接 OpenAI 或兼容 OpenAI API 的模型服务。</p>
        </div>
        <button aria-label="关闭设置" className="icon-button" type="button" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>

      {initializing || !snapshot.unlocked ? (
        <section className="vault-unlock">
          <span className="vault-icon"><DeviceKeyIcon /></span>
          <h3>{initializing ? "正在准备本地安全存储" : "本地安全存储不可用"}</h3>
          <p>应用会自动生成设备密钥并加密保存 API Key，无需设置或记住额外密码。</p>
          {!initializing ? <button className="primary-button wide" type="button" onClick={() => window.location.reload()}>重新尝试</button> : null}
          {error ? <p className="form-message error" role="alert">{error}</p> : null}
        </section>
      ) : (
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
          {notice ? <p className="form-message success" role="status">{notice}</p> : null}
          {error ? <p className="form-message error" role="alert">{error}</p> : null}

          <div className="settings-actions">
            <span className="device-key-note">设备密钥由应用自动管理</span>
            <button className="primary-button" disabled={busy || invalidModels || (insecureDraft && !insecureHttpConfirmed)} type="submit">
              {busy ? "正在保存…" : "保存设置"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function CloseIcon() { return <svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>; }
function DeviceKeyIcon() { return <svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg>; }
function EyeIcon() { return <svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>; }
function EyeOffIcon() { return <svg viewBox="0 0 24 24"><path d="m3 3 18 18M10.6 6.2A9.8 9.8 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-2.1 2.8M6.2 6.2C3.8 8 2.5 12 2.5 12s3.5 6 9.5 6a9 9 0 0 0 3-.5" /></svg>; }
