import { useState, type FormEvent } from "react";
import {
  providerSession,
  type ProviderDraft,
  type ProviderSessionSnapshot,
} from "./providerSession";
import type { ProviderProfile } from "./storage/database";
import { INSECURE_PROVIDER_WARNING, isPlainHttpProviderUrl } from "./providerSecurity";

const EMPTY_DRAFT: ProviderDraft = {
  name: "",
  baseUrl: "https://api.openai.com/v1",
  defaultModel: "",
  apiKey: "",
};

export function ProviderSettings() {
  const [snapshot, setSnapshot] = useState<ProviderSessionSnapshot>(providerSession.snapshot);
  const [password, setPassword] = useState("");
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [insecureHttpConfirmed, setInsecureHttpConfirmed] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();
  const insecureDraft = isPlainHttpProviderUrl(draft.baseUrl);

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
    if (await perform(() => providerSession.unlock(password), "本地密钥库已解锁")) {
      setPassword("");
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const editing = Boolean(draft.id);
    if (
      await perform(
        () => providerSession.save({
          ...draft,
          ...(insecureDraft ? { allowInsecureHttp: insecureHttpConfirmed } : {}),
        }),
        editing ? "Provider 已更新" : "Provider 已保存",
      )
    ) {
      setDraft(EMPTY_DRAFT);
      setInsecureHttpConfirmed(false);
    }
  }

  function edit(profile: ProviderProfile) {
    setDraft({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      defaultModel: profile.defaultModel,
      apiKey: "",
    });
    setError(undefined);
    setNotice("编辑时 API Key 留空将保留原值");
    setInsecureHttpConfirmed(false);
    setPendingDeleteId(undefined);
  }

  async function remove(profile: ProviderProfile) {
    if (await perform(() => providerSession.delete(profile.id), "Provider 已删除")) {
      setPendingDeleteId(undefined);
      if (draft.id === profile.id) {
        setDraft(EMPTY_DRAFT);
        setInsecureHttpConfirmed(false);
      }
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
    <>
      <header>
        <div>
          <p className="eyebrow">LOCAL MODEL PROVIDERS</p>
          <h1>模型服务</h1>
        </div>
        <span className={`status-pill ${snapshot.unlocked ? "ready" : ""}`}>
          <span />{snapshot.unlocked ? "密钥库已解锁" : "密钥库已锁定"}
        </span>
      </header>

      {!snapshot.unlocked ? (
        <section className="vault-card">
          <div>
            <p className="section-label">STRONGHOLD</p>
            <h2>用本地密码保护 API Key</h2>
            <p className="hero-copy">
              密码只用于本机 Stronghold 快照，不上传、不同步，也不会保存到 SQLite。
              首次输入会创建密钥库，之后每次启动需重新解锁。
            </p>
          </div>
          <form className="unlock-form" onSubmit={unlock}>
            <label>
              本地密钥库密码
              <input
                type="password"
                value={password}
                minLength={8}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.currentTarget.value)}
                placeholder="至少 8 个字符"
                required
              />
            </label>
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? "正在解锁…" : "解锁密钥库"}
            </button>
          </form>
          {error ? <p className="error-message">{error}</p> : null}
        </section>
      ) : (
        <div className="provider-layout">
          <section className="provider-list-panel">
            <div className="panel-heading">
              <div><p className="section-label">PROFILES</p><h2>已配置服务</h2></div>
              <button className="text-button" type="button" onClick={() => void lock()} disabled={busy}>锁定</button>
            </div>
            {snapshot.profiles.length === 0 ? (
              <div className="empty-state">还没有 Provider，请添加第一个模型服务。</div>
            ) : (
              <div className="provider-list">
                {snapshot.profiles.map((profile) => {
                  const selected = profile.id === snapshot.selectedProviderId;
                  return (
                    <article className={`provider-item ${selected ? "selected" : ""}`} key={profile.id}>
                      <button className="provider-select" type="button" onClick={() => void perform(() => providerSession.select(profile.id))} disabled={busy}>
                        <span className="provider-avatar">{profile.name.slice(0, 1).toUpperCase()}</span>
                        <span><b>{profile.name}</b><small>{profile.defaultModel}</small></span>
                        {selected ? <em>当前</em> : null}
                      </button>
                      {isPlainHttpProviderUrl(profile.baseUrl) ? (
                        <p className="provider-http-badge">明文 HTTP · 仅限可信本机或局域网</p>
                      ) : null}
                      {pendingDeleteId === profile.id ? (
                        <div className="provider-delete-confirm" role="alertdialog" aria-label={`确认删除 ${profile.name}`}>
                          <p>确认删除“{profile.name}”？对应 API Key 也会从本地密钥库移除，无法撤销。</p>
                          <div>
                            <button type="button" onClick={() => setPendingDeleteId(undefined)} disabled={busy}>保留</button>
                            <button className="danger" type="button" onClick={() => void remove(profile)} disabled={busy}>确认删除</button>
                          </div>
                        </div>
                      ) : (
                        <div className="provider-actions">
                          <button type="button" onClick={() => edit(profile)}>编辑</button>
                          <button className="danger" type="button" onClick={() => {
                            setPendingDeleteId(profile.id);
                            setError(undefined);
                            setNotice(undefined);
                          }} disabled={busy}>删除</button>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="provider-form-panel">
            <p className="section-label">{draft.id ? "EDIT PROFILE" : "NEW PROFILE"}</p>
            <h2>{draft.id ? "编辑 Provider" : "添加 Provider"}</h2>
            <form className="provider-form" onSubmit={save}>
              <label>显示名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} placeholder="例如 OpenAI / Ollama" required /></label>
              <label>API URL<input type="url" value={draft.baseUrl} onChange={(event) => {
                setDraft({ ...draft, baseUrl: event.currentTarget.value });
                setInsecureHttpConfirmed(false);
              }} placeholder="https://api.example.com/v1" required /></label>
              <label>默认模型<input value={draft.defaultModel} onChange={(event) => setDraft({ ...draft, defaultModel: event.currentTarget.value })} placeholder="例如 gpt-4.1-mini" required /></label>
              <label>
                API Key
                <input type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.currentTarget.value })} autoComplete="off" placeholder={draft.id ? "留空以保留原值" : "仅写入本地 Stronghold"} required={!draft.id} />
              </label>
              {insecureDraft ? (
                <div className="provider-security-warning" role="alert">
                  <strong>当前地址使用明文 HTTP</strong>
                  <p>{INSECURE_PROVIDER_WARNING}</p>
                  <label>
                    <input
                      name="allow-insecure-http"
                      type="checkbox"
                      checked={insecureHttpConfirmed}
                      onChange={(event) => setInsecureHttpConfirmed(event.currentTarget.checked)}
                    />
                    我确认该地址属于可信网络，并接受明文传输风险
                  </label>
                </div>
              ) : (
                <p className="form-hint">优先使用 HTTPS；HTTP 地址需要在保存前单独确认风险。</p>
              )}
              <div className="form-actions">
                {draft.id ? <button className="secondary-button" type="button" onClick={() => {
                  setDraft(EMPTY_DRAFT);
                  setInsecureHttpConfirmed(false);
                }}>取消编辑</button> : null}
                <button className="primary-button" type="submit" disabled={busy || (insecureDraft && !insecureHttpConfirmed)}>{busy ? "正在保存…" : "保存 Provider"}</button>
              </div>
            </form>
            {notice ? <p className="success-message">{notice}</p> : null}
            {error ? <p className="error-message">{error}</p> : null}
          </section>
        </div>
      )}
    </>
  );
}
