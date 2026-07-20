import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { LocalChatSession } from "./chatSession";
import { describeChatError } from "./chatError";
import { providerSession } from "./providerSession";
import { getRuntimeServices } from "./runtime";
import type { LocalMessage } from "./storage/repositories";

const CONVERSATION_ID = "default-chat";

export function ChatPage({ openProviders }: { openProviders: () => void }) {
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [session, setSession] = useState<LocalChatSession>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const unlocked = providerSession.snapshot.unlocked && Boolean(providerSession.snapshot.selectedProviderId);

  useEffect(() => {
    let active = true;
    void getRuntimeServices().then(({ client }) => {
      if (!active) return;
      const next = new LocalChatSession(CONVERSATION_ID, client);
      setSession(next);
      return next.load();
    }).then((stored) => {
      if (active && stored) setMessages(stored);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      active = false;
      abortRef.current?.abort();
    };
  }, []);

  const visible = useMemo(() => messages.filter((message) => message.role === "user" || message.role === "assistant"), [messages]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!session || busy || !draft.trim()) return;
    const text = draft.trim();
    const optimistic: LocalMessage = {
      id: `pending-${Date.now()}`,
      conversationId: CONVERSATION_ID,
      sequence: messages.length,
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    setDraft("");
    setError("");
    setStreamingText("");
    setMessages((current) => [...current, optimistic]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await session.send(text, {
        signal: controller.signal,
        onDelta: (_delta, accumulated) => setStreamingText(accumulated),
      });
      setMessages(await session.load());
      setStreamingText("");
    } catch (cause: unknown) {
      setStreamingText("");
      setMessages(await session.load());
      setError(describeChatError(cause));
    } finally {
      abortRef.current = undefined;
      setBusy(false);
    }
  }

  return (
    <div className="chat-page">
      <header>
        <div>
          <p className="eyebrow">FLOW-POWERED CHAT</p>
          <h1>日常聊天</h1>
        </div>
        <span className={`status-pill ${unlocked ? "ready" : "degraded"}`}><span />{unlocked ? "模型已就绪" : "需要模型服务"}</span>
      </header>

      <section className="chat-card">
        <div className="message-list" aria-live="polite">
          {visible.length === 0 && !streamingText ? (
            <div className="chat-empty"><b>从一条消息开始</b><span>对话通过内置 Flow 执行，记录和密钥都只保存在本机。</span></div>
          ) : null}
          {visible.map((message) => (
            <article className={`message-bubble ${message.role}`} key={message.id}>
              <small>{message.role === "user" ? "你" : "NKG"}</small>
              <p>{typeof message.content === "string" ? message.content : JSON.stringify(message.content)}</p>
            </article>
          ))}
          {streamingText ? (
            <article className="message-bubble assistant streaming"><small>NKG · 正在生成</small><p>{streamingText}</p></article>
          ) : null}
        </div>

        {!unlocked ? (
          <div className="chat-provider-notice">请先解锁并选择模型服务。<button type="button" className="text-button" onClick={openProviders}>前往设置</button></div>
        ) : null}
        {error ? <p className="chat-error">{error}</p> : null}
        <form className="chat-composer" onSubmit={send}>
          <textarea aria-label="消息" placeholder="输入消息…" value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy || !unlocked} rows={3} />
          {busy ? (
            <button type="button" className="secondary-button" onClick={() => abortRef.current?.abort()}>停止</button>
          ) : (
            <button type="submit" className="primary-button" disabled={!session || !unlocked || !draft.trim()}>发送</button>
          )}
        </form>
      </section>
    </div>
  );
}
