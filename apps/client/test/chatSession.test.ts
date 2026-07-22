import { describe, expect, it, vi } from "vitest";
import type { NodeEvent } from "@nkg-ai-bot/runtime-router";
import { buildChatPrompt, LocalChatSession, type ChatStore } from "../src/chatSession";
import type { LocalMessage } from "../src/storage/repositories";
import {
  COMPUTER_CONFIG_ASSISTANT_ID,
  type AssistantSkillVersion,
} from "../src/assistantSkills";
import type { ChatImageAttachment } from "../src/chatContent";

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

  it("streams and persists deep reasoning separately from the final answer", async () => {
    const store = memoryStore();
    const runtime = {
      stream: vi.fn(async function* () {
        yield event("stream_artifact", {
          kind: "thinking_delta",
          text: "先确认需求。",
        }, { nodeId: "chat_model", portId: "answer" });
        yield event("stream_artifact", {
          kind: "thinking_delta",
          text: "再给出结论。",
        }, { nodeId: "chat_model", portId: "answer" });
        yield event("stream_delta", { text: "**完成**" }, { nodeId: "chat_model", portId: "answer" });
        yield event("run_finished", {});
      }),
    };
    const reasoning: string[] = [];
    const activities: string[] = [];

    const result = await new LocalChatSession("c1", runtime, store).send("处理一下", {
      onReasoningDelta: (_delta, accumulated) => reasoning.push(accumulated),
      onActivity: (activity) => activities.push(activity.kind),
    });

    expect(reasoning).toEqual(["先确认需求。", "先确认需求。再给出结论。"]);
    expect(activities).toContain("thinking");
    expect(activities.at(-1)).toBe("responding");
    expect(result.assistant.content).toEqual({
      type: "assistant",
      text: "**完成**",
      reasoning: "先确认需求。再给出结论。",
    });
  });

  it("recalls remote memory before the run and writes only the completed turn", async () => {
    const store = memoryStore();
    const runtime = {
      stream: vi.fn(async function* () {
        yield event("run_finished", { output: "已切换到深色主题" });
      }),
    };
    const remoteMemory = {
      isMemoryEnabled: vi.fn(() => true),
      searchMemory: vi.fn(async () => [{
        id: "remote-1",
        content: "用户偏好深色主题",
        relativity: 0.95,
        source: "memos" as const,
      }]),
      addMemoryTurn: vi.fn(async () => undefined),
    };

    await new LocalChatSession(
      "c1",
      runtime,
      store,
      { searchWeb: vi.fn(async () => []) },
      remoteMemory,
    ).send("切换主题");

    expect(remoteMemory.searchMemory).toHaveBeenCalledWith(
      "切换主题",
      "c1",
      expect.objectContaining({ limit: 6 }),
    );
    expect(runtime.stream).toHaveBeenCalledWith(
      "builtin_chat",
      expect.stringContaining("用户偏好深色主题"),
      expect.objectContaining({ flowVersion: "1.0.0" }),
    );
    expect(remoteMemory.addMemoryTurn).toHaveBeenCalledWith("c1", [
      { role: "user", content: "切换主题" },
      { role: "assistant", content: "已切换到深色主题" },
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

  it("persists chat images and sends multimodal input through the Flow", async () => {
    const store = memoryStore();
    const runtime = {
      stream: vi.fn(async function* () {
        yield event("run_finished", { output: "图中是一个蓝色方块" });
      }),
    };
    const image: ChatImageAttachment = {
      id: "image-1",
      name: "square.png",
      mediaType: "image/png",
      data: "aW1hZ2U=",
      bytes: 5,
    };

    await new LocalChatSession("c1", runtime, store).send("这是什么？", { images: [image] });

    expect(store.messages[0]?.content).toEqual({
      type: "multimodal",
      text: "这是什么？",
      images: [image],
    });
    expect(runtime.stream).toHaveBeenCalledWith(
      "builtin_chat",
      expect.objectContaining({
        prompt: expect.stringContaining("[图片 1：square.png]"),
        images: [{ data: "aW1hZ2U=", mediaType: "image/png" }],
      }),
      expect.objectContaining({ flowVersion: "1.0.0" }),
    );
  });

  it("allows an image-only message and skips text web search", async () => {
    const store = memoryStore();
    const runtime = {
      stream: vi.fn(async function* () {
        yield event("run_finished", { output: "收到图片" });
      }),
    };
    const webSearch = { searchWeb: vi.fn(async () => []) };
    const image: ChatImageAttachment = {
      id: "image-1",
      name: "photo.webp",
      mediaType: "image/webp",
      data: "aW1hZ2U=",
      bytes: 5,
    };

    await new LocalChatSession("c1", runtime, store, webSearch).send("", {
      images: [image],
      webSearch: true,
    });

    expect(webSearch.searchWeb).not.toHaveBeenCalled();
    expect(store.messages[0]?.content).toMatchObject({ text: "", images: [image] });
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

  it("passes the conversation model as a run variable without changing the Flow", async () => {
    const store = memoryStore();
    store.getConversation = vi.fn(async () => ({
      id: "c1",
      title: "",
      providerId: "openai",
      modelId: "model-b",
      createdAt: 1,
      updatedAt: 1,
    }));
    const runtime = {
      stream: vi.fn(async function* () {
        yield event("run_finished", { output: "done" });
      }),
    };

    await new LocalChatSession("c1", runtime, store).send("use model b");

    expect(runtime.stream).toHaveBeenCalledWith(
      defaultSkill.flowId,
      expect.any(String),
      expect.objectContaining({
        flowVersion: defaultSkill.flowVersion,
        envOverrides: { variables: { LLM_DEFAULT_MODEL: "model-b" } },
      }),
    );
  });

  it("adds bounded SearXNG results to the prompt when联网 is enabled", async () => {
    const store = memoryStore();
    const runtime = {
      stream: vi.fn(async function* () {
        yield event("run_finished", { output: "带来源的回答" });
      }),
    };
    const webSearch = {
      searchWeb: vi.fn(async () => [{
        title: "Release notes",
        url: "https://example.test/releases/1",
        content: "Version 1 was released today.",
        engine: "bing",
      }]),
    };

    const activities: string[] = [];
    await new LocalChatSession("c1", runtime, store, webSearch).send("今天发布了吗？", {
      webSearch: true,
      onActivity: (activity) => activities.push(activity.kind),
    });

    expect(webSearch.searchWeb).toHaveBeenCalledWith(
      "今天发布了吗？",
      expect.objectContaining({ maxResults: 6 }),
    );
    const prompt = runtime.stream.mock.calls[0]?.[1] as string;
    expect(prompt).toContain("[1] Release notes");
    expect(prompt).toContain("来源：https://example.test/releases/1");
    expect(prompt).toContain("不可信外部内容");
    expect(prompt).toContain("不得编造来源");
    expect(activities[0]).toBe("searching-web");
    expect(activities).toContain("thinking");
  });

  it("delegates the complete computer recommendation pipeline to one Flow run", async () => {
    const store = memoryStore();
    const computerSkill: AssistantSkillVersion = {
      ...defaultSkill,
      assistantId: COMPUTER_CONFIG_ASSISTANT_ID,
      name: "电脑配置顾问",
      systemPrompt: "你是专业电脑配置顾问，必须披露推广链接。",
      flowId: "computer_config_advisor",
      memoryNamespace: "assistant:computer_config_advisor",
    };
    store.resolveAssistantSkill = vi.fn(async () => computerSkill);
    const runtime = {
      stream: vi.fn(async function* () {
        yield event("run_finished", { output: "这是包含推广披露的配置建议" });
      }),
    };
    const webSearch = { searchWeb: vi.fn(async () => []) };

    await new LocalChatSession("c1", runtime, store, webSearch)
      .send("预算 6000 元，帮我配一台 2K 游戏电脑");

    expect(runtime.stream).toHaveBeenCalledTimes(1);
    expect(runtime.stream).toHaveBeenCalledWith(
      "computer_config_advisor",
      expect.stringContaining("预算 6000 元"),
      expect.objectContaining({ flowVersion: computerSkill.flowVersion }),
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
