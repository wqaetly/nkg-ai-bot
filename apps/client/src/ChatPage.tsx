import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  chatMessageFailed,
  chatMessageImages,
  chatMessageReferences,
  chatMessageReasoning,
  chatMessageSummary,
  chatMessageText,
  createChatMessageContent,
  filesToChatImages,
  MAX_CHAT_IMAGES,
  type ChatImageAttachment,
  type ChatWebReference,
} from "./chatContent";
import {
  deleteStoredChatImages,
  loadChatImageDataUrl,
} from "./chatImageStore";
import {
  LocalChatSession,
  type ChatActivity,
  type ChatRuntime,
} from "./chatSession";
import { describeChatError } from "./chatError";
import {
  listMessageFeedback,
  proposeMemoryCandidate,
  upsertMessageFeedback,
  type FeedbackRating,
} from "./learningRepository";
import { MemoryPanel } from "./MemoryPanel";
import { createReflectionJob } from "./learningJobs";
import { LocalMemoryTurnArchiver } from "./localMemoryArchive";
import { ReflectionJobRunner, type ReflectionRuntime } from "./reflectionRunner";
import {
  COMPUTER_CONFIG_ASSISTANT_ID,
  DEFAULT_ASSISTANT_ID,
  filterAssistantSkillIndex,
  listAssistantSkillIndex,
  resolveAssistantSkill,
  type AssistantSkillIndex,
} from "./assistantSkills";
import { AssistantSkillsPanel } from "./AssistantSkillsPanel";
import { EvaluationPanel } from "./EvaluationPanel";
import { ImageGenerationPanel } from "./ImageGenerationPanel";
import { createEvalCaseFromCorrection } from "./evaluationRepository";
import type { EvaluationRuntime } from "./evaluation";
import type { AppPlatform, NodeEvent } from "@nkg-ai-bot/runtime-router";
import {
  type FlowPreviewGraph,
} from "@ai-native-flow/studio/flowPreview";
import type { FlowConfigurableVariable } from "@ai-native-flow/flow-ir";
import { subscribeAppPanel } from "./appPanel";
import { FlowPreviewPanel } from "./FlowPreviewPanel";
import { MarkdownContent } from "./MarkdownContent";
import { ReasoningPanel } from "./ReasoningPanel";
import { SearchReferencesPanel } from "./SearchReferencesPanel";
import { ConversationSidebar } from "./ConversationSidebar";
import { ModelSelector } from "./ModelSelector";
import { ConversationFlowConfigDialog } from "./ConversationFlowConfigDialog";
import {
  flowConfigurableVariables,
  normalizeConversationFlowVariables,
  type ConversationFlowVariables,
} from "./conversationFlowConfig";
import { providerSession, type ProviderSessionSnapshot } from "./providerSession";
import {
  deleteConversation,
  getStoredFlow,
  listConversations,
  listMessages,
  upsertConversation,
  type LocalConversation,
  type LocalMessage,
} from "./storage/repositories";

const SUGGESTIONS = [
  { icon: "✦", title: "帮我整理想法", prompt: "帮我把下面的想法整理成清晰的要点：" },
  { icon: "⌁", title: "解释一个概念", prompt: "请用简单直观的方式解释：" },
  { icon: "↗", title: "制定行动计划", prompt: "请为这个目标制定一份可执行的计划：" },
];

const COMPUTER_CONFIG_SUGGESTIONS = [
  { icon: "⌘", title: "按预算配主机", prompt: "我在中国大陆购买，预算 8000 元，主要用于 2K 游戏和编程，请给我一套完整主机配置。" },
  { icon: "✓", title: "检查现有配置", prompt: "请检查下面这套配置的兼容性、性能瓶颈和预算分配：" },
  { icon: "↗", title: "规划升级路线", prompt: "请根据我的现有电脑、主要用途和预算，给出优先级明确的升级方案：" },
];

const SIDEBAR_COLLAPSED_STORAGE_KEY = "nkg.layout.sidebarCollapsed";

export function ChatPage({
  openCredits,
  openProviders,
}: {
  openCredits: () => void;
  openProviders: () => void;
}) {
  const [conversations, setConversations] = useState<LocalConversation[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [runtime, setRuntime] = useState<ChatRuntime & ReflectionRuntime & EvaluationRuntime>();
  const [platform, setPlatform] = useState<AppPlatform>();
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftImages, setDraftImages] = useState<Record<string, ChatImageAttachment[]>>({});
  const [imageUploadBusy, setImageUploadBusy] = useState(false);
  const [previewImage, setPreviewImage] = useState<ChatImageAttachment>();
  const [streamingText, setStreamingText] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [streamingReferences, setStreamingReferences] = useState<ChatWebReference[]>([]);
  const [chatActivity, setChatActivity] = useState<ChatActivity>();
  const [streamingFlowEvents, setStreamingFlowEvents] = useState<NodeEvent[]>([]);
  const [flowEventsByMessage, setFlowEventsByMessage] = useState<Record<string, NodeEvent[]>>({});
  const [activeFlow, setActiveFlow] = useState<{
    graph: FlowPreviewGraph;
    name: string;
    configurableVariables: FlowConfigurableVariable[];
  }>();
  const [busy, setBusy] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [flowConfigOpen, setFlowConfigOpen] = useState(false);
  const [newConversationSkillId, setNewConversationSkillId] = useState(DEFAULT_ASSISTANT_ID);
  const [copiedId, setCopiedId] = useState<string>();
  const [feedback, setFeedback] = useState<Record<string, FeedbackRating>>({});
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [evaluationOpen, setEvaluationOpen] = useState(false);
  const [imageStudioOpen, setImageStudioOpen] = useState(false);
  const [skills, setSkills] = useState<AssistantSkillIndex[]>([]);
  const [learningNotice, setLearningNotice] = useState("");
  const [correctionMessageId, setCorrectionMessageId] = useState<string>();
  const [correctionDraft, setCorrectionDraft] = useState("");
  const [providerSnapshot, setProviderSnapshot] = useState<ProviderSessionSnapshot>(providerSession.snapshot);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const activeRequestRef = useRef<string | undefined>(undefined);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const composerRegionRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const activeIdRef = useRef<string | undefined>(undefined);

  const draft = activeId ? drafts[activeId] ?? "" : "";
  const pendingImages = activeId ? draftImages[activeId] ?? [] : [];
  const activeConversation = conversations.find((conversation) => conversation.id === activeId);
  const selectedProvider = providerSnapshot.profiles.find(
    (profile) => profile.id === providerSnapshot.selectedProviderId,
  );
  const unlocked = providerSnapshot.unlocked && Boolean(selectedProvider);
  const hostedBalance = selectedProvider?.source === "nkg-hosted"
    ? providerSnapshot.hostedAi?.account?.balance
    : undefined;
  const hostedConnectionState = providerSnapshot.hostedAi?.state;
  const webSearchAvailable = providerSnapshot.webSearch?.enabled === true
    && (providerSnapshot.webSearch.authMode !== "nkg-session" || hostedConnectionState === "ready");
  const affiliateCommerceActive = activeConversation?.assistantId === COMPUTER_CONFIG_ASSISTANT_ID
    && providerSnapshot.commerce?.enabled === true;
  const conversationModel = selectedProvider && activeConversation?.providerId === selectedProvider.id
    && activeConversation.modelId && selectedProvider.enabledModels.includes(activeConversation.modelId)
    ? activeConversation.modelId
    : selectedProvider?.defaultModel;
  const headerModel = unlocked ? conversationModel ?? "未选择模型" : "尚未配置模型";
  const conversationFlowOverrides = activeFlow
    ? normalizeConversationFlowVariables(
        activeFlow.configurableVariables,
        activeConversation?.flowVariables,
      )
    : {};
  const conversationFlowOverrideCount = Object.keys(conversationFlowOverrides).length;
  const reflectionRunner = useMemo(
    () => runtime ? new ReflectionJobRunner(runtime) : undefined,
    [runtime],
  );
  const localMemoryArchiver = useMemo(
    () => reflectionRunner ? new LocalMemoryTurnArchiver(reflectionRunner) : undefined,
    [reflectionRunner],
  );

  useEffect(() => {
    let active = true;
    const syncProvider = () => { if (active) setProviderSnapshot(providerSession.snapshot); };
    const unsubscribeProvider = providerSession.subscribe(syncProvider);
    Promise.all([
      import("./runtime").then(({ getRuntimeServices }) => getRuntimeServices()),
      providerSession.initialize(),
    ]).then(async ([{ client, platform: runtimePlatform }, provider]) => {
      if (!active) return;
      // Runtime startup seeds and migrates built-in Assistant/Flow versions.
      // Read conversations afterwards so the first launch never retains stale
      // pre-migration assistant versions in React state.
      const [stored, assistantSkills] = await Promise.all([
        listConversations(),
        listAssistantSkillIndex(),
      ]);
      if (!active) return;
      setProviderSnapshot(provider);
      setRuntime(client);
      setPlatform(runtimePlatform);
      setSkills(assistantSkills);
      if (stored.length > 0) {
        setConversations(stored);
        setActiveId(stored[0]!.id);
        return;
      }
      const created = await createStoredConversation(selectedProfile(provider));
      if (!active) return;
      setConversations([created]);
      setActiveId(created.id);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      active = false;
      unsubscribeProvider();
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    activeIdRef.current = activeId;
    setStreamingText("");
    setStreamingReasoning("");
    setStreamingReferences([]);
    setStreamingFlowEvents([]);
    setFlowEventsByMessage({});
    setChatActivity(undefined);
    setError("");
    setFlowConfigOpen(false);
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
    let active = true;
    const assistantId = activeConversation?.assistantId;
    const assistantVersion = activeConversation?.assistantVersion;
    setActiveFlow(undefined);
    if (!activeConversation) return () => { active = false; };
    resolveAssistantSkill(assistantId, assistantVersion)
      .then((skill) => getStoredFlow(skill.flowId, skill.flowVersion))
      .then((stored) => {
        if (!active || !stored || !isFlowPreviewGraph(stored.graph)) return;
        setActiveFlow({
          graph: stored.graph,
          name: stored.name,
          configurableVariables: flowConfigurableVariables(stored.graph),
        });
      })
      .catch(() => {
        // A missing preview must never block chat; runtime errors still surface normally.
      });
    return () => { active = false; };
  }, [activeConversation?.id, activeConversation?.assistantId, activeConversation?.assistantVersion]);

  useEffect(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const messageScroll = messageScrollRef.current;
    if (!messageScroll) return;
    messageScroll.scrollTo({
      top: messageScroll.scrollHeight,
      behavior: streamingText ? "auto" : "smooth",
    });
  }, [messages, streamingReasoning, streamingReferences, streamingText, chatActivity, activeId]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [draft]);

  useEffect(() => {
    const composerRegion = composerRegionRef.current;
    const conversationMain = composerRegion?.closest<HTMLElement>(".conversation-main");
    if (!composerRegion || !conversationMain) return;
    const syncComposerHeight = () => {
      conversationMain.style.setProperty(
        "--composer-region-height",
        `${Math.ceil(composerRegion.getBoundingClientRect().height)}px`,
      );
    };
    syncComposerHeight();
    const observer = new ResizeObserver(syncComposerHeight);
    observer.observe(composerRegion);
    return () => {
      observer.disconnect();
      conversationMain.style.removeProperty("--composer-region-height");
    };
  }, []);

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
    if (!memoryOpen && !skillsOpen && !evaluationOpen && !imageStudioOpen
      && !previewImage && !newConversationOpen && !flowConfigOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMemoryOpen(false);
        setSkillsOpen(false);
        setEvaluationOpen(false);
        setImageStudioOpen(false);
        setPreviewImage(undefined);
        setNewConversationOpen(false);
        setFlowConfigOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [evaluationOpen, flowConfigOpen, imageStudioOpen, memoryOpen, newConversationOpen, previewImage, skillsOpen]);

  useEffect(() => subscribeAppPanel((panel) => {
    setSidebarOpen(false);
    if (panel === "memory") setMemoryOpen(true);
    if (panel === "skills") setSkillsOpen(true);
    if (panel === "evaluation") setEvaluationOpen(true);
    if (panel === "image-studio") setImageStudioOpen(true);
  }), []);

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
      flowVariables: {},
    });
    await refreshConversations();
  }

  async function startConversation(assistantId?: string) {
    if (!assistantId) {
      setNewConversationSkillId(DEFAULT_ASSISTANT_ID);
      setNewConversationOpen(true);
      setSidebarOpen(false);
      return;
    }
    stopGeneration();
    const created = await createStoredConversation(selectedProvider, {
      assistantId,
    });
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
  }

  async function removeConversation(id: string) {
    stopGeneration();
    const removedImages = (await listMessages(id)).flatMap((message) => chatMessageImages(message.content));
    await deleteConversation(id);
    void deleteStoredChatImages(removedImages).catch(() => undefined);
    const remaining = conversations.filter((conversation) => conversation.id !== id);
    setDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setDraftImages((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (remaining.length > 0) {
      setConversations(remaining);
      if (id === activeId) setActiveId(remaining[0].id);
      return;
    }
    const created = await createStoredConversation(selectedProvider);
    setConversations([created]);
    setActiveId(created.id);
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!activeId || !runtime || busy || imageUploadBusy || (!draft.trim() && !pendingImages.length) || !unlocked) return;
    if (activeConversation && selectedProvider && conversationModel
      && (activeConversation.providerId !== selectedProvider.id || activeConversation.modelId !== conversationModel)) {
      await upsertConversation({
        ...activeConversation,
        providerId: selectedProvider.id,
        modelId: conversationModel,
      });
      setConversations((current) => current.map((conversation) => conversation.id === activeConversation.id
        ? { ...conversation, providerId: selectedProvider.id, modelId: conversationModel }
        : conversation));
    }
    const conversationId = activeId;
    const text = draft.trim();
    const outgoingImages = [...pendingImages];
    const optimistic: LocalMessage = {
      id: `pending-${Date.now()}`,
      conversationId,
      sequence: messages.length,
      role: "user",
      content: createChatMessageContent(text, outgoingImages),
      createdAt: Date.now(),
    };
    setDrafts((current) => ({ ...current, [conversationId]: "" }));
    setDraftImages((current) => ({ ...current, [conversationId]: [] }));
    setError("");
    setStreamingText("");
    setStreamingReasoning("");
    setStreamingReferences([]);
    setStreamingFlowEvents([]);
    setChatActivity({ kind: "preparing", label: "正在准备请求" });
    setMessages((current) => [...current, optimistic]);
    setBusy(true);
    const controller = new AbortController();
    const requestId = crypto.randomUUID();
    abortRef.current = controller;
    activeRequestRef.current = requestId;
    const session = new LocalChatSession(conversationId, runtime);
    const requestFlowEvents: NodeEvent[] = [];
    try {
      const result = await session.send(text, {
        signal: controller.signal,
        webSearch: webSearchEnabled && webSearchAvailable,
        images: outgoingImages,
        onDelta: (_delta, accumulated) => {
          if (activeRequestRef.current === requestId && activeIdRef.current === conversationId) {
            setStreamingText(accumulated);
          }
        },
        onReasoningDelta: (_delta, accumulated) => {
          if (activeRequestRef.current === requestId && activeIdRef.current === conversationId) {
            setStreamingReasoning(accumulated);
          }
        },
        onSearchResults: (references) => {
          if (activeRequestRef.current === requestId && activeIdRef.current === conversationId) {
            setStreamingReferences(references);
          }
        },
        onActivity: (activity) => {
          if (activeRequestRef.current === requestId && activeIdRef.current === conversationId) {
            setChatActivity(activity);
          }
        },
        onFlowEvent: (event) => {
          if (activeRequestRef.current === requestId && activeIdRef.current === conversationId) {
            requestFlowEvents.push(event);
            setStreamingFlowEvents([...requestFlowEvents]);
          }
        },
      });
      const localMemoryConfig = providerSession.snapshot.localMemory;
      if (!result.failed
        && localMemoryArchiver
        && (localMemoryConfig?.enabled ?? true)
        && (localMemoryConfig?.autoArchive ?? true)) {
        void localMemoryArchiver.enqueue({
          conversationId,
          assistantMessageId: result.assistant.id,
          memoryNamespace: result.memoryNamespace,
        }).catch((cause: unknown) => {
          console.warn("本轮本地记忆自动归档失败，可在记忆任务中重试", cause);
        });
      }
      if (activeIdRef.current === conversationId) {
        setFlowEventsByMessage((current) => ({
          ...current,
          [result.assistant.id]: [...requestFlowEvents],
        }));
        setMessages(await session.load());
        setStreamingText("");
        setStreamingReasoning("");
        setStreamingReferences([]);
        setChatActivity(undefined);
      }
      await refreshConversations();
    } catch (cause: unknown) {
      if (activeIdRef.current === conversationId) {
        setStreamingText("");
        setStreamingReasoning("");
        setStreamingReferences([]);
        setChatActivity(undefined);
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

  async function regenerateMessage(message: LocalMessage) {
    if (!activeId || !runtime || busy || !unlocked || message.role !== "assistant") return;
    const conversationId = activeId;
    setError("");
    setStreamingText("");
    setStreamingReasoning("");
    setStreamingReferences([]);
    setStreamingFlowEvents([]);
    setChatActivity({ kind: "preparing", label: "正在重新生成回复" });
    setBusy(true);
    const controller = new AbortController();
    const requestId = crypto.randomUUID();
    abortRef.current = controller;
    activeRequestRef.current = requestId;
    const session = new LocalChatSession(conversationId, runtime);
    const requestFlowEvents: NodeEvent[] = [];
    try {
      const result = await session.regenerate(message.id, {
        signal: controller.signal,
        webSearch: webSearchEnabled && webSearchAvailable,
        onDelta: (_delta, accumulated) => {
          if (activeRequestRef.current === requestId && activeIdRef.current === conversationId) {
            setStreamingText(accumulated);
          }
        },
        onReasoningDelta: (_delta, accumulated) => {
          if (activeRequestRef.current === requestId && activeIdRef.current === conversationId) {
            setStreamingReasoning(accumulated);
          }
        },
        onSearchResults: (references) => {
          if (activeRequestRef.current === requestId && activeIdRef.current === conversationId) {
            setStreamingReferences(references);
          }
        },
        onActivity: (activity) => {
          if (activeRequestRef.current === requestId && activeIdRef.current === conversationId) {
            setChatActivity(activity);
          }
        },
        onFlowEvent: (event) => {
          if (activeRequestRef.current === requestId && activeIdRef.current === conversationId) {
            requestFlowEvents.push(event);
            setStreamingFlowEvents([...requestFlowEvents]);
          }
        },
      });
      if (activeIdRef.current === conversationId) {
        setFlowEventsByMessage((current) => ({
          ...current,
          [result.assistant.id]: [...requestFlowEvents],
        }));
        setMessages(await session.load());
        setStreamingText("");
        setStreamingReasoning("");
        setStreamingReferences([]);
        setChatActivity(undefined);
      }
      await refreshConversations();
    } catch (cause: unknown) {
      if (activeIdRef.current === conversationId) {
        setStreamingText("");
        setStreamingReasoning("");
        setStreamingReferences([]);
        setChatActivity(undefined);
        setMessages(await session.load());
        setError(describeChatError(cause));
      }
    } finally {
      if (activeRequestRef.current === requestId) {
        abortRef.current = undefined;
        activeRequestRef.current = undefined;
        setBusy(false);
      }
    }
  }

  async function selectConversationModel(modelId: string) {
    if (!activeConversation || !selectedProvider || !selectedProvider.enabledModels.includes(modelId)) return;
    await upsertConversation({
      ...activeConversation,
      providerId: selectedProvider.id,
      modelId,
    });
    await refreshConversations();
  }

  async function saveConversationFlowVariables(values: ConversationFlowVariables) {
    if (!activeConversation || !activeFlow) return;
    const flowVariables = normalizeConversationFlowVariables(
      activeFlow.configurableVariables,
      values,
    );
    await upsertConversation({ ...activeConversation, flowVariables });
    await refreshConversations();
    setFlowConfigOpen(false);
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
    const text = chatMessageSummary(message.content);
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
          question: chatMessageSummary(precedingQuestion.content),
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
        content: chatMessageSummary(message.content),
        sourceMessageId: message.id,
        sourceConversationId: message.conversationId,
      });
      setLearningNotice("已加入记忆候选，请在本地记忆中确认后启用");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function addChatImages(files: FileList | null) {
    const conversationId = activeId;
    if (!conversationId || !files?.length) return;
    setImageUploadBusy(true);
    setError("");
    try {
      const existing = draftImages[conversationId] ?? [];
      const added = await filesToChatImages(files, existing);
      setDraftImages((current) => ({
        ...current,
        [conversationId]: [...(current[conversationId] ?? []), ...added],
      }));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImageUploadBusy(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  }

  function removeDraftImage(imageId: string) {
    if (!activeId) return;
    setDraftImages((current) => ({
      ...current,
      [activeId]: (current[activeId] ?? []).filter((image) => image.id !== imageId),
    }));
  }

  function toggleSidebarCollapsed() {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
      } catch {
        // The current session can still use the collapsed state without persistence.
      }
      return next;
    });
  }

  return (
    <div className={`chat-layout ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      {sidebarOpen ? <button aria-label="关闭会话列表" className="sidebar-backdrop" type="button" onClick={() => setSidebarOpen(false)} /> : null}
      <aside className={`conversation-sidebar ${sidebarOpen ? "open" : ""}`}>
        <button aria-label="关闭会话列表" className="icon-button mobile-only sidebar-mobile-close" type="button" onClick={() => setSidebarOpen(false)}><CloseIcon /></button>

        <ConversationSidebar
          activeId={activeId}
          conversations={conversations}
          enabledModelCount={selectedProvider?.enabledModels.length ?? 0}
          skills={skills}
          unlocked={unlocked}
          onCreateConversation={startConversation}
          onDeleteConversation={removeConversation}
          onOpenSettings={openProviders}
          onSelectConversation={selectConversation}
        />
      </aside>

      <section className="conversation-main">
        <header className="chat-header">
          <div className="chat-header-left">
            <button aria-label="打开会话列表" className="icon-button mobile-only" type="button" onClick={() => setSidebarOpen(true)}><MenuIcon /></button>
            <button
              aria-label={sidebarCollapsed ? "展开左侧栏" : "收起左侧栏"}
              className="icon-button desktop-only sidebar-collapse-toggle"
              title={sidebarCollapsed ? "展开左侧栏" : "收起左侧栏"}
              type="button"
              onClick={toggleSidebarCollapsed}
            ><SidebarIcon collapsed={sidebarCollapsed} /></button>
            <div className="chat-header-summary">
              <h1 title={activeConversation?.title || "新对话"}>{activeConversation?.title || "新对话"}</h1>
              <span className="chat-header-meta" title={`${activeSkillName(skills, activeConversation)} · ${headerModel}`}>
                <span className={unlocked ? "online-dot" : "offline-dot"} />
                <span className="chat-header-skill">{activeSkillName(skills, activeConversation)}</span>
                <span aria-hidden="true">·</span>
                <span className="chat-header-model">{headerModel}</span>
              </span>
            </div>
          </div>
          <div className="chat-header-actions">
            {hostedBalance ? (
              <button
                className="hosted-points-badge"
                title={`购买点数 ${formatPoints(hostedBalance.purchasedPoints)} · 赠送点数 ${formatPoints(hostedBalance.grantedPoints)}`}
                type="button"
                onClick={openCredits}
              >
                <span>AI 点数</span>
                <strong>{formatPoints(hostedBalance.availablePoints)}</strong>
              </button>
            ) : null}
            <button
              aria-label="配置当前 Flow"
              className={`chat-flow-config-button ${conversationFlowOverrideCount ? "configured" : ""}`}
              disabled={!activeFlow?.configurableVariables.length || busy}
              title={activeFlow?.configurableVariables.length
                ? "配置当前对话的 Flow 运行参数"
                : "当前 Flow 没有公开可配置项"}
              type="button"
              onClick={() => setFlowConfigOpen(true)}
            >
              <SlidersIcon />
              {conversationFlowOverrideCount
                ? <span>{conversationFlowOverrideCount}</span>
                : null}
            </button>
          </div>
        </header>

        <div ref={messageScrollRef} className={`message-scroll ${visible.length === 0 && !busy ? "empty" : ""}`} aria-live="polite">
          <div className="message-column">
            {loadingMessages ? (
              <div className="message-loading"><span /><span /><span /></div>
            ) : visible.length === 0 && !busy ? (
              <Welcome assistantId={activeConversation?.assistantId} onSelect={(prompt) => {
                if (!activeId) return;
                setDrafts((current) => ({ ...current, [activeId]: prompt }));
                requestAnimationFrame(() => textareaRef.current?.focus());
              }} />
            ) : null}

            {visible.map((message) => {
              const text = chatMessageText(message.content);
              const failed = chatMessageFailed(message.content);
              const reasoning = chatMessageReasoning(message.content);
              const references = chatMessageReferences(message.content);
              const images = chatMessageImages(message.content);
              return (
              <article className={`message ${message.role}${failed ? " failed" : ""}`} key={message.id}>
                <div className="message-body">
                  {message.role === "assistant" ? <strong className="message-author">NKG</strong> : null}
                  {images.length ? (
                    <div className={`message-image-grid count-${Math.min(images.length, 4)}`}>
                      {images.map((image) => (
                        <button aria-label={`预览图片 ${image.name}`} key={image.id} type="button" onClick={() => setPreviewImage(image)}>
                          <ChatImage image={image} />
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {message.role === "assistant" && references.length
                    ? <SearchReferencesPanel references={references} />
                    : null}
                  {message.role === "assistant" && reasoning
                    ? <ReasoningPanel reasoning={reasoning} />
                    : null}
                  {message.role === "assistant" && activeFlow
                    ? <FlowPreviewPanel
                        graph={activeFlow.graph}
                        name={activeFlow.name}
                        runtimeEvents={flowEventsByMessage[message.id]}
                      />
                    : null}
                  {failed ? <div className="message-failure-label"><AlertIcon />Flow 执行失败</div> : null}
                  {text ? message.role === "assistant"
                    ? <MarkdownContent className="message-content" content={text} />
                    : <div className="message-content">{text}</div>
                  : null}
                  <div className="message-actions">
                    {message.role === "assistant" ? <button disabled={busy || !unlocked} type="button" onClick={() => void regenerateMessage(message)}><RegenerateIcon />{failed ? "重试" : "重新生成"}</button> : null}
                    <button type="button" onClick={() => void copyMessage(message)}>{copiedId === message.id ? <CheckIcon /> : <CopyIcon />}{copiedId === message.id ? "已复制" : "复制"}</button>
                    {!failed ? <button type="button" onClick={() => void rememberMessage(message)}><MemoryIcon />记住</button> : null}
                    {message.role === "assistant" && !failed ? (
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
              );
            })}

            {busy ? (
              <article className="message assistant streaming">
                <div className="message-body">
                  <strong className="message-author">NKG</strong>
                  {chatActivity ? <ChatActivityStatus activity={chatActivity} /> : null}
                  {activeFlow
                    ? <FlowPreviewPanel
                        active
                        graph={activeFlow.graph}
                        name={activeFlow.name}
                        runtimeEvents={streamingFlowEvents}
                      />
                    : null}
                  {streamingReferences.length
                    ? <SearchReferencesPanel references={streamingReferences} />
                    : null}
                  {streamingReasoning
                    ? <ReasoningPanel active={chatActivity?.kind === "thinking"} reasoning={streamingReasoning} />
                    : null}
                  {streamingText
                    ? <div className="streaming-markdown"><MarkdownContent className="message-content" content={streamingText} /><span className="stream-cursor" /></div>
                    : !streamingReasoning ? <div className="thinking-dots"><i /><i /><i /></div> : null}
                </div>
              </article>
            ) : null}
          </div>
        </div>

        <div ref={composerRegionRef} className="composer-region">
          {learningNotice ? <div className="learning-notice" role="status"><MemoryIcon /><span>{learningNotice}</span><button aria-label="关闭提示" type="button" onClick={() => setLearningNotice("")}><CloseIcon /></button></div> : null}
          {!unlocked ? (
            <button className="provider-banner" type="button" onClick={openProviders}>
              <span><KeyIcon /></span><span>
                <strong>{hostedConnectionState === "connecting"
                  ? "正在连接 NKG AI"
                  : hostedConnectionState === "unavailable"
                    ? "NKG AI 暂时不可用"
                    : "连接自己的模型后开始对话"}</strong>
                <small>{hostedConnectionState === "connecting"
                  ? "首次使用会创建本机 AI 点数账户"
                  : hostedConnectionState === "unavailable"
                    ? "可稍后重试或连接自己的模型"
                    : "支持兼容 OpenAI API 的模型服务"}</small>
              </span><ChevronIcon />
            </button>
          ) : null}
          {error ? <div className="chat-error" role="alert"><AlertIcon /><span>{error}</span><button aria-label="关闭错误提示" type="button" onClick={() => setError("")}><CloseIcon /></button></div> : null}
          <form className="composer" onSubmit={(event) => void send(event)}>
            {pendingImages.length ? (
              <div className="composer-attachments" aria-label="待发送图片">
                {pendingImages.map((image) => (
                  <div key={image.id}>
                    <ChatImage image={image} />
                    <button aria-label={`移除图片 ${image.name}`} disabled={busy} type="button" onClick={() => removeDraftImage(image.id)}><CloseIcon /></button>
                    <span>{image.name}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <input
              accept="image/png,image/jpeg,image/webp"
              className="visually-hidden"
              multiple
              ref={imageInputRef}
              type="file"
              onChange={(event) => void addChatImages(event.currentTarget.files)}
            />
            <textarea
              aria-label="消息"
              disabled={!runtime || !unlocked}
              placeholder={unlocked
                ? (pendingImages.length ? "描述图片中的问题（可选）" : "给 NKG 发送消息")
                : hostedConnectionState === "connecting" ? "正在连接 NKG AI…" : "请先连接模型服务"}
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (activeId) setDrafts((current) => ({ ...current, [activeId]: value }));
              }}
              onKeyDown={handleComposerKeyDown}
            />
            <div className="composer-footer">
              <span>{busy ? "正在生成回复…" : "Enter 发送 · Shift + Enter 换行"}</span>
              <div className="composer-controls">
                <button
                  aria-label="上传图片"
                  className="chat-image-upload"
                  disabled={busy || imageUploadBusy || !unlocked || pendingImages.length >= MAX_CHAT_IMAGES}
                  title={`上传图片（最多 ${MAX_CHAT_IMAGES} 张，支持 PNG、JPEG、WebP）`}
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                >
                  {imageUploadBusy ? <span className="upload-spinner" /> : <PaperclipIcon />}
                </button>
                <button
                  aria-pressed={webSearchEnabled && webSearchAvailable}
                  className={`web-search-toggle ${webSearchEnabled && webSearchAvailable ? "active" : ""}`}
                  disabled={busy || !webSearchAvailable}
                  title={webSearchAvailable ? "由 AI 判断并规划本轮联网搜索" : "请先在设置中配置并启用 SearXNG"}
                  type="button"
                  onClick={() => setWebSearchEnabled((value) => !value)}
                >
                  <SearchIcon />联网
                </button>
                {selectedProvider && conversationModel ? (
                  <ModelSelector
                    aria-label="当前对话模型"
                    disabled={busy}
                    models={selectedProvider.enabledModels}
                    value={conversationModel}
                    onChange={(model) => void selectConversationModel(model)}
                    onPing={(model, signal) => providerSession.pingModel(model, signal)}
                  />
                ) : null}
                {busy ? (
                  <button aria-label="停止生成" className="send-button stop" type="button" onClick={stopGeneration}><StopIcon /></button>
                ) : (
                  <button aria-label="发送消息" className="send-button" disabled={!runtime || !unlocked || (!draft.trim() && !pendingImages.length) || imageUploadBusy} type="submit"><ArrowUpIcon /></button>
                )}
              </div>
            </div>
          </form>
          <p className="composer-disclaimer">AI 生成的内容可能不准确，请核查重要信息。{affiliateCommerceActive ? " 商品购买链接属于推广链接，成交后平台可能向我们支付佣金。" : ""}</p>
        </div>
      </section>
      {newConversationOpen ? (
        <div className="settings-layer" role="presentation" onMouseDown={() => setNewConversationOpen(false)}>
          <NewConversationDialog
            selectedAssistantId={newConversationSkillId}
            skills={skills}
            onCancel={() => setNewConversationOpen(false)}
            onConfirm={(assistantId) => {
              setNewConversationOpen(false);
              void startConversation(assistantId);
            }}
            onSelect={setNewConversationSkillId}
          />
        </div>
      ) : null}
      {flowConfigOpen && activeConversation && activeFlow?.configurableVariables.length ? (
        <div className="settings-layer" role="presentation" onMouseDown={() => setFlowConfigOpen(false)}>
          <ConversationFlowConfigDialog
            definitions={activeFlow.configurableVariables}
            flowName={activeFlow.name}
            values={activeConversation.flowVariables ?? {}}
            onCancel={() => setFlowConfigOpen(false)}
            onSave={saveConversationFlowVariables}
          />
        </div>
      ) : null}
      {memoryOpen ? (
        <div className="settings-layer" role="presentation" onMouseDown={() => setMemoryOpen(false)}>
          <section aria-label="本地记忆" aria-modal="true" className="settings-dialog memory-dialog" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
            <MemoryPanel onClose={() => setMemoryOpen(false)} runner={reflectionRunner} />
          </section>
        </div>
      ) : null}
      {imageStudioOpen ? (
        <div className="settings-layer image-studio-layer" role="presentation" onMouseDown={() => setImageStudioOpen(false)}>
          <section aria-label="生图工作台" aria-modal="true" className="settings-dialog image-studio-dialog" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
            <ImageGenerationPanel
              onClose={() => setImageStudioOpen(false)}
              openProviders={() => { setImageStudioOpen(false); openProviders(); }}
            />
          </section>
        </div>
      ) : null}
      {previewImage ? (
        <div className="settings-layer chat-image-preview-layer" role="presentation" onMouseDown={() => setPreviewImage(undefined)}>
          <section aria-label={`图片预览 ${previewImage.name}`} aria-modal="true" className="chat-image-preview" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
            <button aria-label="关闭图片预览" type="button" onClick={() => setPreviewImage(undefined)}><CloseIcon /></button>
            <ChatImage image={previewImage} />
            <span>{previewImage.name}</span>
          </section>
        </div>
      ) : null}
      {skillsOpen ? (
        <div className="settings-layer" role="presentation" onMouseDown={() => setSkillsOpen(false)}>
          <section aria-label="能力中心" aria-modal="true" className="settings-dialog skill-dialog capability-dialog" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
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

function NewConversationDialog({
  selectedAssistantId,
  skills,
  onCancel,
  onConfirm,
  onSelect,
}: {
  selectedAssistantId: string;
  skills: AssistantSkillIndex[];
  onCancel: () => void;
  onConfirm: (assistantId: string) => void;
  onSelect: (assistantId: string) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const orderedSkills = useMemo(() => [...skills].sort((left, right) => {
    if (left.assistantId === DEFAULT_ASSISTANT_ID) return -1;
    if (right.assistantId === DEFAULT_ASSISTANT_ID) return 1;
    return left.name.localeCompare(right.name, "zh-CN");
  }), [skills]);
  const visibleSkills = useMemo(
    () => filterAssistantSkillIndex(orderedSkills, searchQuery),
    [orderedSkills, searchQuery],
  );
  const selectedSkill = visibleSkills.find((skill) => skill.assistantId === selectedAssistantId);

  function updateSearchQuery(nextQuery: string) {
    setSearchQuery(nextQuery);
    const nextSkills = filterAssistantSkillIndex(orderedSkills, nextQuery);
    if (nextSkills.length > 0 && !nextSkills.some((skill) => skill.assistantId === selectedAssistantId)) {
      onSelect(nextSkills[0].assistantId);
    }
  }

  return (
    <form
      aria-labelledby="new-conversation-title"
      aria-modal="true"
      className="settings-dialog new-conversation-dialog"
      role="dialog"
      onMouseDown={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        if (selectedSkill) onConfirm(selectedSkill.assistantId);
      }}
    >
      <header>
        <h2 id="new-conversation-title">新建对话</h2>
        <p>选择这个对话要使用的助手，默认使用 NKG。</p>
      </header>
      <div className="new-conversation-search">
        <MagnifierIcon />
        <label className="visually-hidden" htmlFor="new-conversation-search-input">搜索助手</label>
        <input
          autoFocus
          id="new-conversation-search-input"
          placeholder="搜索名称、描述或能力"
          type="search"
          value={searchQuery}
          onChange={(event) => updateSearchQuery(event.currentTarget.value)}
        />
        <small aria-live="polite">{visibleSkills.length} / {orderedSkills.length}</small>
      </div>
      <div aria-label="选择助手" className="new-conversation-skill-list" role="radiogroup">
        {visibleSkills.map((skill) => (
          <label className={skill.assistantId === selectedAssistantId ? "selected" : ""} key={skill.assistantId}>
            <input
              checked={skill.assistantId === selectedAssistantId}
              name="new-conversation-skill"
              type="radio"
              value={skill.assistantId}
              onChange={() => onSelect(skill.assistantId)}
            />
            <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
            {skill.assistantId === DEFAULT_ASSISTANT_ID ? <em>默认</em> : null}
          </label>
        ))}
        {orderedSkills.length === 0 ? <p>正在加载助手…</p> : null}
        {orderedSkills.length > 0 && visibleSkills.length === 0 ? <p>没有匹配的助手</p> : null}
      </div>
      <footer>
        <button className="ghost-button" type="button" onClick={onCancel}>取消</button>
        <button className="primary-button" disabled={!selectedSkill} type="submit">创建对话</button>
      </footer>
    </form>
  );
}

function ChatActivityStatus({ activity }: { activity: ChatActivity }) {
  return (
    <div className={`chat-activity ${activity.kind}`} role="status">
      <span className="chat-activity-indicator" aria-hidden="true"><i /><i /><i /></span>
      <span>{activity.label}</span>
    </div>
  );
}

function ChatImage({ image }: { image: ChatImageAttachment }) {
  const [source, setSource] = useState(() => image.data ? `data:${image.mediaType};base64,${image.data}` : "");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    void loadChatImageDataUrl(image)
      .then((value) => {
        if (active) setSource(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [image.data, image.mediaType, image.name, image.path]);

  return failed
    ? <span className="chat-image-missing" role="img" aria-label={`图片 ${image.name} 无法读取`}>图片无法读取</span>
    : <img alt={image.name} aria-busy={!source} src={source || undefined} />;
}

function Welcome({
  assistantId,
  onSelect,
}: {
  assistantId?: string;
  onSelect: (prompt: string) => void;
}) {
  const computerConfigMode = assistantId === COMPUTER_CONFIG_ASSISTANT_ID;
  const suggestions = computerConfigMode ? COMPUTER_CONFIG_SUGGESTIONS : SUGGESTIONS;
  return (
    <div className="welcome">
      <span className="welcome-mark">{computerConfigMode ? "PC" : "N"}</span>
      <h2>{computerConfigMode ? "准备配一台怎样的电脑？" : "今天想聊些什么？"}</h2>
      <p>{computerConfigMode
        ? "告诉我预算、购买地区、用途和偏好，我会给出配置、兼容性检查与升级路线。"
        : "我可以帮你梳理想法、解释问题，或一起制定下一步计划。"}</p>
      <div className="suggestion-grid">
        {suggestions.map((suggestion) => (
          <button key={suggestion.title} type="button" onClick={() => onSelect(suggestion.prompt)}>
            <span>{suggestion.icon}</span><strong>{suggestion.title}</strong><small>{suggestion.prompt}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

async function createStoredConversation(
  provider?: { id: string; defaultModel: string },
  placement: { assistantId?: string } = {},
): Promise<LocalConversation> {
  const now = Date.now();
  const skill = await resolveAssistantSkill(placement.assistantId);
  const conversation: LocalConversation = {
    id: crypto.randomUUID(),
    title: "新对话",
    assistantId: skill.assistantId,
    assistantVersion: skill.version,
    ...(provider ? { providerId: provider.id, modelId: provider.defaultModel } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await upsertConversation(conversation);
  return conversation;
}

function selectedProfile(snapshot: ProviderSessionSnapshot) {
  return snapshot.profiles.find((profile) => profile.id === snapshot.selectedProviderId);
}

function formatPoints(points: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(points);
}

function activeSkillName(
  skills: AssistantSkillIndex[],
  conversation: LocalConversation | undefined,
): string {
  return skills.find((skill) => skill.assistantId === conversation?.assistantId)?.name ?? "NKG";
}

function isFlowPreviewGraph(value: unknown): value is FlowPreviewGraph {
  if (!value || typeof value !== "object") return false;
  const graph = value as { nodes?: unknown; edges?: unknown };
  return Array.isArray(graph.nodes) && Array.isArray(graph.edges);
}

function Icon({ children }: { children: React.ReactNode }) { return <svg aria-hidden viewBox="0 0 24 24">{children}</svg>; }
function MenuIcon() { return <Icon><path d="M4 7h16M4 12h16M4 17h16" /></Icon>; }
function SidebarIcon({ collapsed }: { collapsed: boolean }) { return <Icon><rect height="16" rx="2" width="18" x="3" y="4" /><path d="M9 4v16" />{collapsed ? <path d="m13 9 3 3-3 3" /> : <path d="m16 9-3 3 3 3" />}</Icon>; }
function SlidersIcon() { return <Icon><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M10 14v6" /><circle cx="14" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></Icon>; }
function CloseIcon() { return <Icon><path d="m6 6 12 12M18 6 6 18" /></Icon>; }
function ChevronIcon() { return <Icon><path d="m9 6 6 6-6 6" /></Icon>; }
function KeyIcon() { return <Icon><circle cx="8" cy="12" r="4" /><path d="M12 12h9M17 12v3M20 12v2" /></Icon>; }
function CopyIcon() { return <Icon><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Icon>; }
function RegenerateIcon() { return <Icon><path d="M20 7v5h-5M4 17v-5h5" /><path d="M18.1 9A7 7 0 0 0 6.2 6.2L4 9m16 6-2.2 2.8A7 7 0 0 1 5.9 15" /></Icon>; }
function MemoryIcon() { return <Icon><path d="M12 5.5c-1.2-2-4.4-1.6-4.8.8A3.4 3.4 0 0 0 5 11.8c-1.1 2.1.4 4.7 2.8 4.8.7 2.7 4.2 2.8 4.2.1V5.5ZM12 5.5c1.2-2 4.4-1.6 4.8.8a3.4 3.4 0 0 1 2.2 5.5c1.1 2.1-.4 4.7-2.8 4.8-.7 2.7-4.2 2.8-4.2.1" /><path d="M8 9.5c1.3 0 2 .6 2 1.8M16 9.5c-1.3 0-2 .6-2 1.8M8.2 16.4c.1-1.5.8-2.4 2.1-2.7M15.8 16.4c-.1-1.5-.8-2.4-2.1-2.7" /></Icon>; }
function ThumbUpIcon() { return <Icon><path d="M7 10v10H3V10h4Zm0 9h9.2a2 2 0 0 0 1.9-1.4l2-6A2 2 0 0 0 18.2 9H14l.7-3.3A2.2 2.2 0 0 0 12.6 3L7 10" /></Icon>; }
function ThumbDownIcon() { return <Icon><path d="M7 14V4H3v10h4Zm0-9h9.2a2 2 0 0 1 1.9 1.4l2 6a2 2 0 0 1-1.9 2.6H14l.7 3.3a2.2 2.2 0 0 1-2.1 2.7L7 14" /></Icon>; }
function CheckIcon() { return <Icon><path d="m5 12 4 4L19 6" /></Icon>; }
function AlertIcon() { return <Icon><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v5M12 17h.01" /></Icon>; }
function StopIcon() { return <Icon><rect x="7" y="7" width="10" height="10" rx="2" /></Icon>; }
function ArrowUpIcon() { return <Icon><path d="m6 11 6-6 6 6M12 5v14" /></Icon>; }
function SearchIcon() { return <Icon><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4M8 11h6M11 8v6" /></Icon>; }
function MagnifierIcon() { return <Icon><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></Icon>; }
function PaperclipIcon() { return <Icon><path d="m20.5 11.5-8.2 8.2a6 6 0 0 1-8.5-8.5l8.8-8.8a4 4 0 0 1 5.7 5.7l-8.9 8.8a2 2 0 0 1-2.8-2.8l8.2-8.2" /></Icon>; }
