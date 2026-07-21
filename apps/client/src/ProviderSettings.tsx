import { useEffect, useState, type FormEvent } from "react";
import {
  providerSession,
  type ProviderDraft,
  type ProviderSessionSnapshot,
} from "./providerSession";
import { INSECURE_PROVIDER_WARNING, isPlainHttpProviderUrl } from "./providerSecurity";

const EMPTY_DRAFT: ProviderDraft = {
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-4.1-mini",
  apiKey: "",
};

export function ProviderSettings({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<ProviderSessionSnapshot>(providerSession.snapshot);
  const [password, setPassword] = useState("");
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [showApiKey, setShowApiKey] = useState(false);
  const [insecureHttpConfirmed, setInsecureHttpConfirmed] = useState(false);
  const insecureDraft = isPlainHttpProviderUrl(draft.baseUrl);
  const selected = snapshot.profiles.find((profile) => profile.id === snapshot.selectedProviderId)
    ?? snapshot.profiles[0];

  useEffect(() => {
    if (!selected) return;
    setDraft({
      id: selected.id,
      name: "OpenAI",
      baseUrl: selected.baseUrl,
      defaultModel: selected.defaultModel,
      apiKey: "",
    });
  }, [selected?.id, selected?.baseUrl, selected?.defaultModel]);

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

  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (await perform(() => providerSession.unlock(password))) setPassword("");
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
      "连接配置已保存在本机",
    );
    if (saved) {
      setDraft((current) => ({ ...current, apiKey: "" }));
      setInsecureHttpConfirmed(false);
    }
  }

  async function lock() {
    setBusy(true);
    setError(undefined);
    try {
      await providerSession.lock();
      setSnapshot(providerSession.snapshot);
      setDraft(EMPTY_DRAFT);
      setNotice(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

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

      {!snapshot.unlocked ? (
        <section className="vault-unlock">
          <span className="vault-icon"><LockIcon /></span>
          <h3>解锁本地密钥库</h3>
          <p>API Key 使用 Stronghold 加密保存在当前设备。首次输入将创建密钥库，以后启动应用时用同一密码解锁。</p>
          <form onSubmit={unlock}>
            <label htmlFor="vault-password">本地密钥库密码</label>
            <input
              autoFocus
              autoComplete="current-password"
              id="vault-password"
              minLength={8}
              placeholder="至少 8 个字符"
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
            <button className="primary-button wide" disabled={busy} type="submit">
              {busy ? "正在解锁…" : "解锁并继续"}
            </button>
          </form>
          {error ? <p className="form-message error" role="alert">{error}</p> : null}
        </section>
      ) : (
        <form className="openai-form" onSubmit={save}>
          <div className="connection-status">
            <span className="openai-mark">AI</span>
            <div><strong>OpenAI Compatible</strong><small>{selected ? "已配置，可用于对话" : "等待完成配置"}</small></div>
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

          <label htmlFor="openai-model">模型</label>
          <input
            id="openai-model"
            placeholder="gpt-4.1-mini"
            required
            value={draft.defaultModel}
            onChange={(event) => setDraft({ ...draft, defaultModel: event.currentTarget.value })}
          />

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
          <p className="field-hint">密钥不会写入 SQLite，也不会离开当前设备。</p>

          {insecureDraft ? (
            <label className="security-warning">
              <input
                checked={insecureHttpConfirmed}
                type="checkbox"
                onChange={(event) => setInsecureHttpConfirmed(event.currentTarget.checked)}
              />
              <span><strong>确认使用明文 HTTP</strong><small>{INSECURE_PROVIDER_WARNING}</small></span>
            </label>
          ) : null}

          {notice ? <p className="form-message success" role="status">{notice}</p> : null}
          {error ? <p className="form-message error" role="alert">{error}</p> : null}

          <div className="settings-actions">
            <button className="ghost-button" disabled={busy} type="button" onClick={() => void lock()}>锁定密钥库</button>
            <button className="primary-button" disabled={busy || (insecureDraft && !insecureHttpConfirmed)} type="submit">
              {busy ? "正在保存…" : "保存设置"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function CloseIcon() { return <svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>; }
function LockIcon() { return <svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>; }
function EyeIcon() { return <svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>; }
function EyeOffIcon() { return <svg viewBox="0 0 24 24"><path d="m3 3 18 18M10.6 6.2A9.8 9.8 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-2.1 2.8M6.2 6.2C3.8 8 2.5 12 2.5 12s3.5 6 9.5 6a9 9 0 0 0 3-.5" /></svg>; }
