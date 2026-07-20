import type { NodeEvent } from "@nkg-ai-bot/runtime-router";
import { BUILTIN_CHAT_FLOW_ID, BUILTIN_CHAT_FLOW_VERSION } from "./builtinFlows";
import {
  appendMessage,
  listMessages,
  upsertConversation,
  type LocalMessage,
} from "./storage/repositories";

export interface ChatRuntime {
  stream(
    flowId: string,
    input: unknown,
    options?: { flowVersion?: string; signal?: AbortSignal },
  ): AsyncIterable<NodeEvent>;
}

export interface ChatStore {
  listMessages(conversationId: string): Promise<LocalMessage[]>;
  upsertConversation(input: {
    id: string;
    title: string;
    roleId?: string;
    assistantId?: string;
  }): Promise<void>;
  appendMessage(input: {
    id: string;
    conversationId: string;
    role: LocalMessage["role"];
    content: unknown;
  }): Promise<LocalMessage>;
}

const sqliteChatStore: ChatStore = {
  listMessages: (conversationId) => listMessages(conversationId),
  upsertConversation: (input) => upsertConversation(input),
  appendMessage: (input) => appendMessage(input),
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

    const history = await this.store.listMessages(this.conversationId);
    await this.store.upsertConversation({
      id: this.conversationId,
      title: firstTitle(history, content),
    });
    const user = await this.store.appendMessage({
      id: crypto.randomUUID(),
      conversationId: this.conversationId,
      role: "user",
      content,
    });

    const prompt = buildChatPrompt([...history, user]);
    let answer = "";
    let terminalError: Error | undefined;
    let runId: string | undefined;

    for await (const event of this.runtime.stream(BUILTIN_CHAT_FLOW_ID, prompt, {
      flowVersion: BUILTIN_CHAT_FLOW_VERSION,
      ...(options.signal ? { signal: options.signal } : {}),
    })) {
      runId ??= event.runId;
      if (event.kind === "stream_delta" && event.nodeId === "chat_model") {
        const delta = readTextDelta(event.payload);
        if (delta) {
          answer += delta;
          options.onDelta?.(delta, answer);
        }
      }
      if (event.kind === "node_error" || event.kind === "run_failed") {
        terminalError = new Error(readRuntimeError(event.payload));
      }
      if (event.kind === "run_cancelled") {
        terminalError = new DOMException("聊天已取消", "AbortError");
      }
    }

    if (terminalError) throw terminalError;
    if (!answer.trim()) throw new Error("模型没有返回文本内容");

    const assistant = await this.store.appendMessage({
      id: crypto.randomUUID(),
      conversationId: this.conversationId,
      role: "assistant",
      content: answer,
    });
    return { user, assistant, ...(runId ? { runId } : {}) };
  }
}

export function buildChatPrompt(messages: LocalMessage[]): string {
  const transcript = messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "system")
    .map((message) => `${roleLabel(message.role)}：${messageText(message.content)}`)
    .join("\n\n");
  return [
    "你是一个可靠、自然的 AI 对话助手。请直接回答最后一条用户消息，并结合前文保持上下文一致。",
    "下面是本地保存的对话记录：",
    transcript,
    "助手：",
  ].join("\n\n");
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
