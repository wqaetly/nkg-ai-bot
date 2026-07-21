import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LocalChatSession, type ChatRuntime } from "./chatSession";
import { describeChatError } from "./chatError";
import {
  listMessageFeedback,
  proposeMemoryCandidate,
  upsertMessageFeedback,
  type FeedbackRating,
} from "./learningRepository";
import { MemoryPanel } from "./MemoryPanel";
import { createReflectionJob } from "./learningJobs";
import { ReflectionJobRunner, type ReflectionRuntime } from "./reflectionRunner";
import { resolveAssistantSkill } from "./assistantSkills";
import { listAssistantSkillIndex, type AssistantSkillIndex } from "./assistantSkills";
import { AssistantSkillsPanel } from "./AssistantSkillsPanel";
import { EvaluationPanel } from "./EvaluationPanel";
import { createEvalCaseFromCorrection } from "./evaluationRepository";
import type { EvaluationRuntime } from "./evaluation";
import type { AppPlatform } from "@nkg-ai-bot/runtime-router";
import { providerSession } from "./providerSession";
import {
  deleteConversation,
  listConversations,
  upsertConversation,
  type LocalConversation,
  type LocalMessage,
} from "./storage/repositories";

const SUGGESTIONS = [
  { icon: "✦", title: "帮我整理想法", prompt: "帮我把下面的想法整理成清晰的要点：" },
  { icon: "⌁", title: "解释一个概念", prompt: "请用简单直观的方式解释：" },
  { icon: "↗", title: "制定行动计划", prompt: "请为这个目标制定一份可执行的计划：" },
];

export function ChatPage({ openProviders }: { openProviders: () => void }) {
  const [conversations, setConversations] = useState<LocalConversation[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [runtime, setRuntime] = useState<ChatRuntime & ReflectionRuntime & EvaluationRuntime>();
  const [platform, setPlatform] = useState<AppPlatform>();
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [streamingText, setStreamingText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();
  const [copiedId, setCopiedId] = useState<string>();
  const [feedback, setFeedback] = useState<Record<string, FeedbackRating>>({});
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [evaluationOpen, setEvaluationOpen] = useState(false);
  const [skills, setSkills] = useState<AssistantSkillIndex[]>([]);
  const [learningNotice, setLearningNotice] = useState("");
  const [correctionMessageId, setCorrectionMessageId] = useState<string>();
  const [correctionDraft, setCorrectionDraft] = useState("");
  const abortRef = useRef<AbortController | undefined>(undefined);
  const activeRequestRef = useRef<string | undefined>(undefined);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeIdRef = useRef<string | undefined>(undefined);

  const draft = activeId ? drafts[activeId] ?? "" : "";
  const activeConversation = conversations.find((conversation) => conversation.id === activeId);
  const selectedProvider = providerSession.snapshot.profiles.find(
    (profile) => profile.id === providerSession.snapshot.selectedProviderId,
  );
  const unlocked = providerSession.snapshot.unlocked && Boolean(selectedProvider);
  const reflectionRunner = useMemo(
    () => runtime ? new ReflectionJobRunner(runtime) : undefined,
    [runtime],
  );

  useEffect(() => {
    let active = true;
    Promise.all([
      import("./runtime").then(({ getRuntimeServices }) => getRuntimeServices()),
      listConversations(),
    ]).then(async ([{ client, platform: runtimePlatform }, stored]) => {
      if (!active) return;
      setRuntime(client);
      setPlatform(runtimePlatform);
      setSkills(await listAssistantSkillIndex());
      if (stored.length > 0) {
        setConversations(stored);
        setActiveId(stored[0]!.id);
        return;
      }
      const created = await createStoredConversation();
      if (!active) return;
      setConversations([created]);
      setActiveId(created.id);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      active = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    activeIdRef.current = activeId;
    setStreamingText("");
    setError("");
    if (!activeId || !runtime) return;
    let active = true;
    setLoadingMessages(true);
    Promise.all([
      new LocalChatSession(activeId, runtime).load(),
      listMessageFeedback(activeId),
    ])
      .then(([stored, storedFeedback]) => {
        if (!active) return;
        setMessages(stored);
        setFeedback(Object.fromEntries(storedFeedback.map((item) => [item.messageId, item.rating])));
      })
      .catch((cause: unknown) => { if (active) setError(describeChatError(cause)); })
      .finally(() => { if (active) setLoadingMessages(false); });
    return () => { active = false; };
  }, [activeId, runtime]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: streamingText ? "auto" : "smooth" });
  }, [messages, streamingText, activeId]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [draft]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void startConversation();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (!memoryOpen && !skillsOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMemoryOpen(false);
        setSkillsOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [memoryOpen, skillsOpen]);

  const visible = useMemo(
    () => messages.filter((message) => message.role === "user" || message.role === "assistant"),
    [messages],
  );

  async function refreshConversations() {
    setConversations(await listConversations());
  }

  async function refreshSkills() {
    setSkills(await listAssistantSkillIndex());
  }

  async function selectAssistantSkill(skill: AssistantSkillIndex) {
    if (!activeConversation || visible.length > 0) return;
    await upsertConversation({
      ...activeConversation,
      assistantId: skill.assistantId,
      assistantVersion: skill.activeVersion,
    });
    await refreshConversations();
  }

  async function startConversation() {
    stopGeneration();
    const created = await createStoredConversation();
    setConversations((current) => [created, ...current]);
    setActiveId(created.id);
    setMessages([]);
    setSidebarOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function selectConversation(id: string) {
    if (id === activeId) {
      setSidebarOpen(false);
      return;
    }
    stopGeneration();
    setActiveId(id);
    setMessages([]);
    setSidebarOpen(false);
    setPendingDeleteId(undefined);
  }

  async function removeConversation(id: string) {
    stopGeneration();
    await deleteConversation(id);
    const remaining = conversations.filter((conversation) => conversation.id !== id);
    setPendingDeleteId(undefined);
    setDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (remaining.length > 0) {
      setConversations(remaining);
      if (id === activeId) setActiveId(remaining[0].id);
      return;
    }
    const created = await createStoredConversation();
    setConversations([created]);
    setActiveId(created.id);
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!activeId || !runtime || busy || !draft.trim() || !unlocked) return;
    const conversationId = activeId;
    const text = draft.trim();
    const optimistic: LocalMessage = {
      id: `pending-${Date.now()}`,
      conversationId,
      sequence: messages.length,
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    setDrafts((current) => ({ ...current, [conversationId]: "" }));
    setError("");
    setStreamingText("");
    setMessages((current) => [...current, optimistic]);
    setBusy(true);
    const controller = new AbortController();
    const requestId = crypto.randomUUID();
    abortRef.current = controller;
    activeRequestRef.current = requestId;
    const session = new LocalChatSession(conversationId, runtime);
    try {
      await session.send(text, {
        signal: controller.signal,
        onDelta: (_delta, accumulated) => {
          if (activeRequestRef.current === requestId && activeIdRef.current === conversationId) {
            setStreamingText(accumulated);
          }
        },
      });
      if (activeIdRef.current === conversationId) {
        setMessages(await session.load());
        setStreamingText("");
      }
      await refreshConversations();
    } catch (cause: unknown) {
      if (activeIdRef.current === conversationId) {
        setStreamingText("");
        setMessages(await session.load());
        setError(describeChatError(cause));
      }
      await refreshConversations();
    } finally {
      if (activeRequestRef.current === requestId) {
        abortRef.current = undefined;
        activeRequestRef.current = undefined;
        setBusy(false);
      }
    }
  }

  function stopGeneration() {
    abortRef.current?.abort();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  async function copyMessage(message: LocalMessage) {
    const text = messageText(message.content);
    await navigator.clipboard.writeText(text);
    setCopiedId(message.id);
    window.setTimeout(() => setCopiedId((current) => current === message.id ? undefined : current), 1400);
  }

  async function rateMessage(message: LocalMessage, rating: FeedbackRating, correction?: string): Promise<boolean> {
    try {
      const saved = await upsertMessageFeedback({
        messageId: message.id,
        conversationId: message.conversationId,
        rating,
        ...(correction?.trim() ? { correction: correction.trim() } : {}),
      });
      setFeedback((current) => ({ ...current, [message.id]: saved.rating }));
      setLearningNotice(rating === "positive" ? "已记录这条回复有帮助" : "已记录这条回复需要改进");
      if (correction?.trim()) {
        setCorrectionMessageId(undefined);
        setCorrectionDraft("");
        setLearningNotice("已在本地保存你的纠正，后续评测会优先使用");
      }
      return true;
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }

  async function saveCorrectionAndReflect(message: LocalMessage) {
    if (!reflectionRunner || !correctionDraft.trim()) return;
    if (!await rateMessage(message, "negative", correctionDraft)) return;
    try {
      const precedingQuestion = [...messages]
        .filter((item) => item.role === "user" && item.sequence < message.sequence)
        .sort((left, right) => right.sequence - left.sequence)[0];
      if (precedingQuestion && activeConversation?.assistantId && activeConversation.assistantVersion) {
        await createEvalCaseFromCorrection({
          assistantId: activeConversation.assistantId,
          assistantVersion: activeConversation.assistantVersion,
          question: messageText(precedingQuestion.content),
          correction: correctionDraft,
          sourceMessageId: message.id,
        });
      }
      const job = await createReflectionJob({
        sourceConversationId: message.conversationId,
        sourceMessageId: message.id,
      });
      setLearningNotice("已创建本地反思任务；结果仍需你在记忆面板中批准");
      void reflectionRunner.run(job.id)
        .then((completed) => {
          const proposed = typeof completed.result?.proposedCount === "number"
            ? completed.result.proposedCount
            : 0;
          setLearningNotice(proposed > 0
            ? `反思完成，生成 ${proposed} 条待审记忆候选`
            : "反思完成，没有发现足够可靠的新事实");
        })
        .catch((cause: unknown) => {
          if (cause instanceof Error && cause.name === "AbortError") {
            setLearningNotice("反思任务已中断，可在本地记忆中继续");
            return;
          }
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function rememberMessage(message: LocalMessage) {
    try {
      await proposeMemoryCandidate({
        content: messageText(message.content),
        sourceMessageId: message.id,
        sourceConversationId: message.conversationId,
      });
      setLearningNotice("已加入记忆候选，请在本地记忆中确认后启用");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="chat-layout">
      {sidebarOpen ? <button aria-label="关闭会话列表" className="sidebar-backdrop" type="button" onClick={() => setSidebarOpen(false)} /> : null}
      <aside className={`conversation-sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-brand">
          <span className="brand-orb">N</span>
          <div><strong>NKG</strong><small>AI Assistant</small></div>
          <button aria-label="关闭会话列表" className="icon-button mobile-only" type="button" onClick={() => setSidebarOpen(false)}><CloseIcon /></button>
        </div>

        <button className="new-chat-button" type="button" onClick={() => void startConversation()}>
          <PlusIcon /><span>新对话</span><kbd>Ctrl N</kbd>
        </button>

        <div className="conversation-section-label">最近对话</div>
        <nav aria-label="会话列表" className="conversation-list">
          {conversations.map((conversation) => (
            <div className={`conversation-row ${conversation.id === activeId ? "active" : ""}`} key={conversation.id}>
              {pendingDeleteId === conversation.id ? (
                <div className="delete-confirm">
                  <span>删除这条对话？</span>
                  <button type="button" onClick={() => setPendingDeleteId(undefined)}>取消</button>
                  <button className="danger" type="button" onClick={() => void removeConversation(conversation.id)}>删除</button>
                </div>
              ) : (
                <>
                  <button className="conversation-select" type="button" onClick={() => selectConversation(conversation.id)}>
                    <ChatIcon />
                    <span><strong>{conversation.title || "新对话"}</strong><small>{formatRelativeTime(conversation.updatedAt)}</small></span>
                  </button>
                  <button aria-label={`删除 ${conversation.title || "新对话"}`} className="conversation-delete" type="button" onClick={() => setPendingDeleteId(conversation.id)}><TrashIcon /></button>
                </>
              )}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button type="button" onClick={() => { setEvaluationOpen(true); setSidebarOpen(false); }}>
            <span className="footer-icon"><EvaluationIcon /></span>
            <span><strong>评测与发布</strong><small>冻结回放、门禁与版本发布</small></span>
            <ChevronIcon />
          </button>
          <button type="button" onClick={() => { setSkillsOpen(true); setSidebarOpen(false); }}>
            <span className="footer-icon"><SkillIcon /></span>
            <span><strong>助手技能</strong><small>{skills.length} 个本地 Flow Skill</small></span>
            <ChevronIcon />
          </button>
          <button type="button" onClick={() => { setMemoryOpen(true); setSidebarOpen(false); }}>
            <span className="footer-icon"><MemoryIcon /></span>
            <span><strong>本地记忆</strong><small>审核、编辑与停用事实</small></span>
            <ChevronIcon />
          </button>
          <button type="button" onClick={openProviders}>
            <span className="footer-icon"><SettingsIcon /></span>
            <span><strong>OpenAI 设置</strong><small>{unlocked ? selectedProvider?.defaultModel : "配置 API URL 与密钥"}</small></span>
            <ChevronIcon />
          </button>
          <div className="local-note"><ShieldIcon /> 对话与密钥仅保存在本机</div>
        </div>
      </aside>

      <section className="conversation-main">
        <header className="chat-header">
          <div className="chat-header-left">
            <button aria-label="打开会话列表" className="icon-button mobile-only" type="button" onClick={() => setSidebarOpen(true)}><MenuIcon /></button>
            <button aria-label="打开助手技能" className="assistant-avatar assistant-avatar-button" type="button" onClick={() => setSkillsOpen(true)}>{activeSkillName(skills, activeConversation).slice(0, 1).toUpperCase()}</button>
            <div><h1>{activeConversation?.title || "新对话"}</h1><p><span className={unlocked ? "online-dot" : "offline-dot"} />{activeSkillName(skills, activeConversation)} · {activeConversation?.assistantVersion ?? "1.0.0"} · {unlocked ? selectedProvider?.defaultModel : "尚未配置模型"}</p></div>
          </div>
          <div className="header-actions">
            <button aria-label="打开本地记忆" className="header-settings" type="button" onClick={() => setMemoryOpen(true)}><MemoryIcon /><span>记忆</span></button>
            <button className="header-settings" type="button" onClick={openProviders}><SettingsIcon /><span>设置</span></button>
          </div>
        </header>

        <div className={`message-scroll ${visible.length === 0 && !streamingText ? "empty" : ""}`} aria-live="polite">
          <div className="message-column">
            {loadingMessages ? (
              <div className="message-loading"><span /><span /><span /></div>
            ) : visible.length === 0 && !streamingText ? (
              <Welcome onSelect={(prompt) => {
                if (!activeId) return;
                setDrafts((current) => ({ ...current, [activeId]: prompt }));
                requestAnimationFrame(() => textareaRef.current?.focus());
              }} />
            ) : null}

            {visible.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                {message.role === "assistant" ? <span className="message-avatar">N</span> : null}
                <div className="message-body">
                  {message.role === "assistant" ? <strong className="message-author">NKG</strong> : null}
                  <div className="message-content">{messageText(message.content)}</div>
                  <div className="message-actions">
                    <button type="button" onClick={() => void copyMessage(message)}>{copiedId === message.id ? <CheckIcon /> : <CopyIcon />}{copiedId === message.id ? "已复制" : "复制"}</button>
                    <button type="button" onClick={() => void rememberMessage(message)}><MemoryIcon />记住</button>
                    {message.role === "assistant" ? (
                      <>
                        <button aria-label="这条回复有帮助" className={feedback[message.id] === "positive" ? "active" : ""} type="button" onClick={() => void rateMessage(message, "positive")}><ThumbUpIcon /></button>
                        <button aria-label="这条回复需要改进" className={feedback[message.id] === "negative" ? "active negative" : ""} type="button" onClick={() => { void rateMessage(message, "negative"); setCorrectionMessageId(message.id); setCorrectionDraft(""); }}><ThumbDownIcon /></button>
                      </>
                    ) : null}
                  </div>
                  {message.role === "assistant" && correctionMessageId === message.id ? (
                    <div className="feedback-correction">
                      <label htmlFor={`correction-${message.id}`}>正确答案或改进建议（可选）</label>
                      <textarea id={`correction-${message.id}`} placeholder="告诉 NKG 应该怎样回答…" rows={2} value={correctionDraft} onChange={(event) => setCorrectionDraft(event.currentTarget.value)} />
                      <div>
                        <button type="button" onClick={() => { setCorrectionMessageId(undefined); setCorrectionDraft(""); }}>跳过</button>
                        <button className="save" disabled={!correctionDraft.trim() || !reflectionRunner} type="button" onClick={() => void saveCorrectionAndReflect(message)}>保存并分析</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </article>
            ))}

            {streamingText ? (
              <article className="message assistant streaming">
                <span className="message-avatar">N</span>
                <div className="message-body"><strong className="message-author">NKG</strong><div className="message-content">{streamingText}<span className="stream-cursor" /></div></div>
              </article>
            ) : busy ? (
              <article className="message assistant streaming">
                <span className="message-avatar">N</span>
                <div className="message-body"><strong className="message-author">NKG</strong><div className="thinking-dots"><i /><i /><i /></div></div>
              </article>
            ) : null}
            <div ref={messageEndRef} />
          </div>
        </div>

        <div className="composer-region">
          {learningNotice ? <div className="learning-notice" role="status"><MemoryIcon /><span>{learningNotice}</span><button aria-label="关闭提示" type="button" onClick={() => setLearningNotice("")}><CloseIcon /></button></div> : null}
          {!unlocked ? (
            <button className="provider-banner" type="button" onClick={openProviders}>
              <span><KeyIcon /></span><span><strong>连接 OpenAI 后开始对话</strong><small>配置 API URL 与 API Key</small></span><ChevronIcon />
            </button>
          ) : null}
          {error ? <div className="chat-error" role="alert"><AlertIcon /><span>{error}</span><button aria-label="关闭错误提示" type="button" onClick={() => setError("")}><CloseIcon /></button></div> : null}
          <form className="composer" onSubmit={(event) => void send(event)}>
            <textarea
              aria-label="消息"
              disabled={!runtime || !unlocked}
              placeholder={unlocked ? "给 NKG 发送消息" : "请先配置 OpenAI"}
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(event) => activeId && setDrafts((current) => ({ ...current, [activeId]: event.currentTarget.value }))}
              onKeyDown={handleComposerKeyDown}
            />
            <div className="composer-footer">
              <span>{busy ? "正在生成回复…" : "Enter 发送 · Shift + Enter 换行"}</span>
              {busy ? (
                <button aria-label="停止生成" className="send-button stop" type="button" onClick={stopGeneration}><StopIcon /></button>
              ) : (
                <button aria-label="发送消息" className="send-button" disabled={!runtime || !unlocked || !draft.trim()} type="submit"><ArrowUpIcon /></button>
              )}
            </div>
          </form>
          <p className="composer-disclaimer">AI 生成的内容可能不准确，请核查重要信息。</p>
        </div>
      </section>
      {memoryOpen ? (
        <div className="settings-layer" role="presentation" onMouseDown={() => setMemoryOpen(false)}>
          <section aria-label="本地记忆" aria-modal="true" className="settings-dialog memory-dialog" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
            <MemoryPanel onClose={() => setMemoryOpen(false)} runner={reflectionRunner} />
          </section>
        </div>
      ) : null}
      {skillsOpen ? (
        <div className="settings-layer" role="presentation" onMouseDown={() => setSkillsOpen(false)}>
          <section aria-label="助手技能" aria-modal="true" className="settings-dialog skill-dialog" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
            <AssistantSkillsPanel
              onClose={() => setSkillsOpen(false)}
              onSelect={selectAssistantSkill}
              onChanged={refreshSkills}
              selectedAssistantId={activeConversation?.assistantId}
              selectedVersion={activeConversation?.assistantVersion}
              selectionLocked={loadingMessages || visible.length > 0 || busy}
            />
          </section>
        </div>
      ) : null}
      {evaluationOpen && runtime && platform ? (
        <div className="settings-layer" role="presentation" onMouseDown={() => setEvaluationOpen(false)}>
          <section aria-label="评测与发布" aria-modal="true" className="settings-dialog evaluation-dialog" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
            <EvaluationPanel
              onClose={() => setEvaluationOpen(false)}
              onPublished={refreshSkills}
              platform={platform}
              runtime={runtime}
            />
          </section>
        </div>
      ) : null}
    </div>
  );
}

function Welcome({ onSelect }: { onSelect: (prompt: string) => void }) {
  return (
    <div className="welcome">
      <span className="welcome-mark">N</span>
      <h2>今天想聊些什么？</h2>
      <p>我可以帮你梳理想法、解释问题，或一起制定下一步计划。</p>
      <div className="suggestion-grid">
        {SUGGESTIONS.map((suggestion) => (
          <button key={suggestion.title} type="button" onClick={() => onSelect(suggestion.prompt)}>
            <span>{suggestion.icon}</span><strong>{suggestion.title}</strong><small>{suggestion.prompt}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

async function createStoredConversation(): Promise<LocalConversation> {
  const now = Date.now();
  const skill = await resolveAssistantSkill();
  const conversation: LocalConversation = {
    id: crypto.randomUUID(),
    title: "新对话",
    assistantId: skill.assistantId,
    assistantVersion: skill.version,
    createdAt: now,
    updatedAt: now,
  };
  await upsertConversation(conversation);
  return conversation;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  try { return JSON.stringify(content, null, 2); } catch { return String(content); }
}

function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 172_800_000) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(timestamp);
}

function activeSkillName(
  skills: AssistantSkillIndex[],
  conversation: LocalConversation | undefined,
): string {
  return skills.find((skill) => skill.assistantId === conversation?.assistantId)?.name ?? "NKG";
}

function Icon({ children }: { children: React.ReactNode }) { return <svg aria-hidden viewBox="0 0 24 24">{children}</svg>; }
function MenuIcon() { return <Icon><path d="M4 7h16M4 12h16M4 17h16" /></Icon>; }
function CloseIcon() { return <Icon><path d="m6 6 12 12M18 6 6 18" /></Icon>; }
function PlusIcon() { return <Icon><path d="M12 5v14M5 12h14" /></Icon>; }
function ChatIcon() { return <Icon><path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 9 9 0 0 1-3.7-.8L4 20l1.4-3.8A7.7 7.7 0 0 1 4 11.5 7.5 7.5 0 0 1 12 4a7.5 7.5 0 0 1 8 7.5Z" /></Icon>; }
function TrashIcon() { return <Icon><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5M14 11v5" /></Icon>; }
function SettingsIcon() { return <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></Icon>; }
function ChevronIcon() { return <Icon><path d="m9 6 6 6-6 6" /></Icon>; }
function ShieldIcon() { return <Icon><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></Icon>; }
function KeyIcon() { return <Icon><circle cx="8" cy="12" r="4" /><path d="M12 12h9M17 12v3M20 12v2" /></Icon>; }
function CopyIcon() { return <Icon><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Icon>; }
function MemoryIcon() { return <Icon><path d="M12 5.5c-1.2-2-4.4-1.6-4.8.8A3.4 3.4 0 0 0 5 11.8c-1.1 2.1.4 4.7 2.8 4.8.7 2.7 4.2 2.8 4.2.1V5.5ZM12 5.5c1.2-2 4.4-1.6 4.8.8a3.4 3.4 0 0 1 2.2 5.5c1.1 2.1-.4 4.7-2.8 4.8-.7 2.7-4.2 2.8-4.2.1" /><path d="M8 9.5c1.3 0 2 .6 2 1.8M16 9.5c-1.3 0-2 .6-2 1.8M8.2 16.4c.1-1.5.8-2.4 2.1-2.7M15.8 16.4c-.1-1.5-.8-2.4-2.1-2.7" /></Icon>; }
function SkillIcon() { return <Icon><path d="m12 3 2.1 4.9L19 10l-4.9 2.1L12 17l-2.1-4.9L5 10l4.9-2.1L12 3Z" /><path d="m19 16 .8 1.8L22 19l-2.2 1.2L19 22l-.8-1.8L16 19l2.2-1.2L19 16Z" /></Icon>; }
function EvaluationIcon() { return <Icon><path d="M5 4h14v16H5zM8 8h8M8 12h3M8 16h5" /><path d="m14 14 1.4 1.4L18 13" /></Icon>; }
function ThumbUpIcon() { return <Icon><path d="M7 10v10H3V10h4Zm0 9h9.2a2 2 0 0 0 1.9-1.4l2-6A2 2 0 0 0 18.2 9H14l.7-3.3A2.2 2.2 0 0 0 12.6 3L7 10" /></Icon>; }
function ThumbDownIcon() { return <Icon><path d="M7 14V4H3v10h4Zm0-9h9.2a2 2 0 0 1 1.9 1.4l2 6a2 2 0 0 1-1.9 2.6H14l.7 3.3a2.2 2.2 0 0 1-2.1 2.7L7 14" /></Icon>; }
function CheckIcon() { return <Icon><path d="m5 12 4 4L19 6" /></Icon>; }
function AlertIcon() { return <Icon><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v5M12 17h.01" /></Icon>; }
function StopIcon() { return <Icon><rect x="7" y="7" width="10" height="10" rx="2" /></Icon>; }
function ArrowUpIcon() { return <Icon><path d="m6 11 6-6 6 6M12 5v14" /></Icon>; }
