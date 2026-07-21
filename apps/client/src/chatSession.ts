import type { FlowInvokeOptions, NodeEvent } from "@nkg-ai-bot/runtime-router";
import { listRelevantMemories, type MemoryItem } from "./learningRepository";
import {
  finishAssistantSkillRun,
  resolveAssistantSkill,
  startAssistantSkillRun,
  type AssistantRunStatus,
  type AssistantSkillVersion,
  DEFAULT_ASSISTANT_SYSTEM_PROMPT,
} from "./assistantSkills";
import {
  appendMessage,
  getConversation,
  listMessages,
  upsertConversation,
  type LocalConversation,
  type LocalMessage,
} from "./storage/repositories";

export interface ChatRuntime {
  stream(
    flowId: string,
    input: unknown,
    options?: FlowInvokeOptions,
  ): AsyncIterable<NodeEvent>;
}

export interface ChatStore {
  listMessages(conversationId: string): Promise<LocalMessage[]>;
  listRelevantMemories(query: string, namespace: string): Promise<MemoryItem[]>;
  getConversation(conversationId: string): Promise<LocalConversation | undefined>;
  resolveAssistantSkill(assistantId?: string, version?: string): Promise<AssistantSkillVersion>;
  upsertConversation(input: {
    id: string;
    title: string;
    roleId?: string;
    assistantId?: string;
    assistantVersion?: string;
    providerId?: string;
    modelId?: string;
  }): Promise<void>;
  appendMessage(input: {
    id: string;
    conversationId: string;
    role: LocalMessage["role"];
    content: unknown;
  }): Promise<LocalMessage>;
  startAssistantRun(input: {
    id: string;
    conversationId: string;
    userMessageId: string;
    skill: AssistantSkillVersion;
  }): Promise<void>;
  finishAssistantRun(
    id: string,
    input: {
      status: AssistantRunStatus;
      runtimeRunId?: string;
      assistantMessageId?: string;
      error?: unknown;
    },
  ): Promise<void>;
}

const sqliteChatStore: ChatStore = {
  listMessages: (conversationId) => listMessages(conversationId),
  listRelevantMemories: (query, namespace) => listRelevantMemories(query, 8, namespace),
  getConversation: (conversationId) => getConversation(conversationId),
  resolveAssistantSkill: (assistantId, version) => resolveAssistantSkill(assistantId, version),
  upsertConversation: (input) => upsertConversation(input),
  appendMessage: (input) => appendMessage(input),
  startAssistantRun: (input) => startAssistantSkillRun(input),
  finishAssistantRun: (id, input) => finishAssistantSkillRun(id, input),
};

export interface SendChatOptions {
  onDelta?: (delta: string, accumulated: string) => void;
  signal?: AbortSignal;
}

export interface SendChatResult {
  user: LocalMessage;
  assistant: LocalMessage;
  runId?: string;
}

export class LocalChatSession {
  constructor(
    readonly conversationId: string,
    private readonly runtime: ChatRuntime,
    private readonly store: ChatStore = sqliteChatStore,
  ) {}

  load(): Promise<LocalMessage[]> {
    return this.store.listMessages(this.conversationId);
  }

  async send(text: string, options: SendChatOptions = {}): Promise<SendChatResult> {
    const content = text.trim();
    if (!content) throw new Error("消息不能为空");

    const [history, conversation] = await Promise.all([
      this.store.listMessages(this.conversationId),
      this.store.getConversation(this.conversationId),
    ]);
    const skill = await this.store.resolveAssistantSkill(
      conversation?.assistantId,
      conversation?.assistantVersion,
    );
    await this.store.upsertConversation({
      id: this.conversationId,
      title: firstTitle(history, content),
      ...(conversation?.roleId ? { roleId: conversation.roleId } : {}),
      assistantId: skill.assistantId,
      assistantVersion: skill.version,
      ...(conversation?.providerId ? { providerId: conversation.providerId } : {}),
      ...(conversation?.modelId ? { modelId: conversation.modelId } : {}),
    });
    const user = await this.store.appendMessage({
      id: crypto.randomUUID(),
      conversationId: this.conversationId,
      role: "user",
      content,
    });

    const memories = await this.store.listRelevantMemories(content, skill.memoryNamespace);
    const prompt = buildChatPrompt([...history, user], memories, skill.systemPrompt);
    let answer = "";
    let finalOutput = "";
    let terminalError: Error | undefined;
    let runId: string | undefined;
    const assistantRunId = crypto.randomUUID();
    await this.store.startAssistantRun({
      id: assistantRunId,
      conversationId: this.conversationId,
      userMessageId: user.id,
      skill,
    });

    try {
      for await (const event of this.runtime.stream(skill.flowId, prompt, {
        flowVersion: skill.flowVersion,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(conversation?.modelId ? {
          envOverrides: { variables: { LLM_DEFAULT_MODEL: conversation.modelId } },
        } : {}),
      })) {
        runId ??= event.runId;
        if (event.kind === "stream_delta" && (event.portId === "answer" || event.nodeId === "chat_model")) {
          const delta = readTextDelta(event.payload);
          if (delta) {
            answer += delta;
            options.onDelta?.(delta, answer);
          }
        }
        if (event.kind === "run_finished") {
          finalOutput = readRunOutput(event.payload);
        }
        if (event.kind === "node_error" || event.kind === "run_failed") {
          terminalError = new Error(readRuntimeError(event.payload));
        }
        if (event.kind === "run_cancelled") {
          terminalError = new DOMException("聊天已取消", "AbortError");
        }
      }

      if (terminalError) throw terminalError;
      if (!answer.trim() && finalOutput.trim()) answer = finalOutput;
      if (!answer.trim()) throw new Error("模型没有返回文本内容");

      const assistant = await this.store.appendMessage({
        id: crypto.randomUUID(),
        conversationId: this.conversationId,
        role: "assistant",
        content: answer,
      });
      await this.store.finishAssistantRun(assistantRunId, {
        status: "succeeded",
        ...(runId ? { runtimeRunId: runId } : {}),
        assistantMessageId: assistant.id,
      });
      return { user, assistant, ...(runId ? { runId } : {}) };
    } catch (error: unknown) {
      await this.store.finishAssistantRun(assistantRunId, {
        status: isAbort(error) ? "cancelled" : "failed",
        ...(runId ? { runtimeRunId: runId } : {}),
        error,
      });
      throw error;
    }
  }
}

export function buildChatPrompt(
  messages: LocalMessage[],
  memories: MemoryItem[] = [],
  systemPrompt = DEFAULT_ASSISTANT_SYSTEM_PROMPT,
): string {
  const transcript = messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "system")
    .map((message) => `${roleLabel(message.role)}：${messageText(message.content)}`)
    .join("\n\n");
  const approvedMemory = memories.length > 0
    ? [
      "以下是用户已经批准、且与当前问题相关的本地事实记忆。仅在确实相关时使用；若与用户当前表达冲突，以当前表达为准：",
      ...boundedMemoryLines(memories),
    ].join("\n")
    : "";
  return [
    systemPrompt,
    approvedMemory,
    "下面是本地保存的对话记录：",
    transcript,
    "助手：",
  ].filter(Boolean).join("\n\n");
}

function boundedMemoryLines(memories: MemoryItem[], maxCharacters = 4_000): string[] {
  const lines: string[] = [];
  let characters = 0;
  for (const memory of memories.slice(0, 20)) {
    const line = `- ${memory.content}`;
    if (characters + line.length > maxCharacters) break;
    lines.push(line);
    characters += line.length;
  }
  return lines;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function roleLabel(role: LocalMessage["role"]): string {
  if (role === "assistant") return "助手";
  if (role === "system") return "系统";
  if (role === "tool") return "工具";
  return "用户";
}

function firstTitle(history: LocalMessage[], content: string): string {
  if (history.length > 0) return messageText(history.find((message) => message.role === "user")?.content ?? content).slice(0, 40);
  return content.slice(0, 40);
}

function readTextDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function readRuntimeError(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "Flow 执行失败";
  const error = (payload as { error?: unknown }).error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  const message = (payload as { message?: unknown }).message;
  return typeof message === "string" && message ? message : "Flow 执行失败";
}

function readRunOutput(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const output = (payload as { output?: unknown }).output;
  return typeof output === "string" ? output : "";
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
