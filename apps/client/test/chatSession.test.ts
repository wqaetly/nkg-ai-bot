import { describe, expect, it, vi } from "vitest";
import type { NodeEvent } from "@nkg-ai-bot/runtime-router";
import { buildChatPrompt, LocalChatSession, type ChatStore } from "../src/chatSession";
import type { LocalMessage } from "../src/storage/repositories";
import type { AssistantSkillVersion } from "../src/assistantSkills";

const defaultSkill: AssistantSkillVersion = {
  assistantId: "builtin_assistant",
  version: "1.0.0",
  name: "NKG",
  description: "",
  systemPrompt: "你是测试助手。",
  flowId: "builtin_chat",
  flowVersion: "1.0.0",
  memoryNamespace: "global",
  capabilities: ["network.http", "secret.read"],
  activationHints: [],
  createdAt: 1,
};

function message(sequence: number, role: LocalMessage["role"], content: unknown): LocalMessage {
  return {
    id: `m${sequence}`,
    conversationId: "c1",
    sequence,
    role,
    content,
    createdAt: sequence,
  };
}

function event(kind: string, payload: unknown, extra: Partial<NodeEvent> = {}): NodeEvent {
  return {
    eventId: crypto.randomUUID(),
    runId: "run-1",
    flowId: "builtin_chat",
    flowVersion: "1.0.0",
    seq: 1,
    timestamp: new Date(0).toISOString(),
    kind,
    payload,
    ...extra,
  };
}

function memoryStore(initial: LocalMessage[] = []): ChatStore & { messages: LocalMessage[] } {
  const store = {
    messages: [...initial],
    async listMessages() { return [...store.messages]; },
    async listRelevantMemories() { return []; },
    async getConversation() {
      return { id: "c1", title: "", createdAt: 1, updatedAt: 1 };
    },
    async resolveAssistantSkill() { return defaultSkill; },
    async upsertConversation() {},
    async startAssistantRun() {},
    async finishAssistantRun() {},
    async appendMessage(input: { id: string; conversationId: string; role: LocalMessage["role"]; content: unknown }) {
      const saved: LocalMessage = {
        ...input,
        sequence: store.messages.length,
        createdAt: Date.now(),
      };
      store.messages.push(saved);
      return saved;
    },
  };
  return store;
}

describe("LocalChatSession", () => {
  it("streams the built-in Flow, publishes deltas, and persists both messages", async () => {
    const store = memoryStore();
    const runtime = {
      stream: vi.fn(async function* () {
        yield event("run_started", {});
        yield event("stream_delta", { text: "你" }, { nodeId: "chat_model", portId: "answer" });
        yield event("stream_delta", { text: "好" }, { nodeId: "chat_model", portId: "answer" });
        yield event("run_finished", {});
      }),
    };
    const deltas: string[] = [];

    const result = await new LocalChatSession("c1", runtime, store).send("你好", {
      onDelta: (_delta, accumulated) => deltas.push(accumulated),
    });

    expect(runtime.stream).toHaveBeenCalledWith(
      "builtin_chat",
      expect.stringContaining("你是测试助手。"),
      expect.objectContaining({ flowVersion: "1.0.0" }),
    );
    expect(deltas).toEqual(["你", "你好"]);
    expect(result.runId).toBe("run-1");
    expect(store.messages.map((item) => [item.role, item.content])).toEqual([
      ["user", "你好"],
      ["assistant", "你好"],
    ]);
  });

  it("does not persist a partial assistant response when the Flow fails", async () => {
    const store = memoryStore();
    store.finishAssistantRun = vi.fn(store.finishAssistantRun);
    const runtime = {
      async *stream() {
        yield event("stream_delta", { text: "半" }, { nodeId: "chat_model" });
        yield event("run_failed", { error: { message: "provider unavailable" } });
      },
    };

    await expect(new LocalChatSession("c1", runtime, store).send("测试"))
      .rejects.toThrow("provider unavailable");
    expect(store.messages.map((item) => item.role)).toEqual(["user"]);
    expect(store.finishAssistantRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "failed", runtimeRunId: "run-1" }),
    );
  });

  it("executes the immutable Assistant Skill bound to the conversation", async () => {
    const store = memoryStore();
    const customSkill: AssistantSkillVersion = {
      ...defaultSkill,
      assistantId: "writer",
      version: "2.1.0",
      name: "Writer",
      systemPrompt: "你是一个简洁的写作助手。",
      flowId: "writer_flow",
      flowVersion: "3.0.0",
      memoryNamespace: "assistant:writer",
    };
    store.getConversation = vi.fn(async () => ({
      id: "c1",
      title: "",
      assistantId: "writer",
      assistantVersion: "2.1.0",
      createdAt: 1,
      updatedAt: 1,
    }));
    store.resolveAssistantSkill = vi.fn(async () => customSkill);
    store.listRelevantMemories = vi.fn(async () => []);
    store.startAssistantRun = vi.fn(async () => undefined);
    store.finishAssistantRun = vi.fn(async () => undefined);
    const runtime = {
      stream: vi.fn(async function* () {
        yield event("run_finished", { output: "最终结果" });
      }),
    };

    const result = await new LocalChatSession("c1", runtime, store).send("帮我改写");

    expect(store.resolveAssistantSkill).toHaveBeenCalledWith("writer", "2.1.0");
    expect(store.listRelevantMemories).toHaveBeenCalledWith("帮我改写", "assistant:writer");
    expect(runtime.stream).toHaveBeenCalledWith(
      "writer_flow",
      expect.stringContaining("你是一个简洁的写作助手。"),
      expect.objectContaining({ flowVersion: "3.0.0" }),
    );
    expect(result.assistant.content).toBe("最终结果");
    expect(store.startAssistantRun).toHaveBeenCalledWith(expect.objectContaining({ skill: customSkill }));
    expect(store.finishAssistantRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "succeeded", runtimeRunId: "run-1" }),
    );
  });

  it("builds a local multi-turn transcript without leaking tool messages", () => {
    const prompt = buildChatPrompt([
      message(0, "user", "第一问"),
      message(1, "assistant", "第一答"),
      message(2, "tool", { secret: "internal" }),
      message(3, "user", "第二问"),
    ]);

    expect(prompt).toContain("用户：第一问");
    expect(prompt).toContain("助手：第一答");
    expect(prompt).toContain("用户：第二问");
    expect(prompt).not.toContain("internal");
  });

  it("injects only approved relevant memories supplied by the local store", () => {
    const prompt = buildChatPrompt(
      [message(0, "user", "我喜欢什么颜色？")],
      [{
        id: "memory-1",
        namespace: "global",
        content: "用户喜欢蓝色",
        confidence: 1,
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }],
    );

    expect(prompt).toContain("用户已经批准");
    expect(prompt).toContain("- 用户喜欢蓝色");
    expect(prompt).toContain("若与用户当前表达冲突，以当前表达为准");
  });

  it("bounds the approved memory block before it reaches the model", () => {
    const memories = Array.from({ length: 6 }, (_, index) => ({
      id: `memory-${index}`,
      namespace: "global",
      content: `${index}${"x".repeat(998)}`,
      confidence: 1,
      status: "active" as const,
      createdAt: index,
      updatedAt: index,
    }));
    const prompt = buildChatPrompt([message(0, "user", "test")], memories);

    expect(prompt).toContain("- 0");
    expect(prompt).toContain("- 2");
    expect(prompt).not.toContain("- 3");
  });
});
