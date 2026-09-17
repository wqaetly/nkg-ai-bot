import { describe, expect, it, vi } from "vitest";
import type { NodeEvent } from "@nkg-ai-bot/runtime-router";
import { buildChatPrompt, LocalChatSession, type ChatStore } from "../src/chatSession";
import type {
  ConversationCompression,
  LocalMessage,
} from "../src/storage/repositories";
import {
  COMPUTER_CONFIG_ASSISTANT_ID,
  type AssistantSkillVersion,
} from "../src/assistantSkills";
import type { ChatImageAttachment } from "../src/chatContent";
import type { ChatImageStore } from "../src/chatImageStore";

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

function memoryStore(initial: LocalMessage[] = []): ChatStore & {
  compressions: ConversationCompression[];
  messages: LocalMessage[];
} {
  const store = {
    messages: [...initial],
    compressions: [] as ConversationCompression[],
    async listMessages() { return [...store.messages]; },
    async listRelevantMemories() { return []; },
    async getConversation() {
      return { id: "c1", title: "", createdAt: 1, updatedAt: 1 };
    },
    async resolveAssistantSkill() { return defaultSkill; },
    async upsertConversation() {},
    async startAssistantRun() {},
    async finishAssistantRun() {},
    async getLatestCompression(_conversationId: string, maxThroughSequence = Number.MAX_SAFE_INTEGER) {
      return [...store.compressions]
        .filter((item) => item.status === "completed" && item.throughSequence <= maxThroughSequence)
        .sort((left, right) => right.throughSequence - left.throughSequence)[0];
    },
    async startCompression(input: {
      id: string;
      conversationId: string;
      throughSequence: number;
      sourceTokenCount: number;
      modelId?: string;
    }) {
      store.compressions.push({
        ...input,
        summary: "",
        summaryTokenCount: 0,
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    async completeCompression(id: string, summary: string, summaryTokenCount: number) {
      const item = store.compressions.find((candidate) => candidate.id === id);
      if (!item) throw new Error("compression missing");
      Object.assign(item, { summary, summaryTokenCount, status: "completed", updatedAt: Date.now() });
    },
    async failCompression(id: string, error: string) {
      const item = store.compressions.find((candidate) => candidate.id === id);
      if (item) Object.assign(item, { error, status: "failed", updatedAt: Date.now() });
    },
    async invalidateCompressionsFrom(_conversationId: string, sequence: number) {
      for (const item of store.compressions) {
        if (item.status === "completed" && item.throughSequence >= sequence) {
          item.status = "stale";
        }
      }
    },
    async appendMessage(input: { id: string; conversationId: string; role: LocalMessage["role"]; content: unknown }) {
      const saved: LocalMessage = {
        ...input,
        sequence: store.messages.length,
        createdAt: Date.now(),
      };
      store.messages.push(saved);
      return saved;
    },
    async updateMessageContent(id: string, content: unknown) {
      const index = store.messages.findIndex((item) => item.id === id && item.role === "assistant");
      if (index < 0) throw new Error("Assistant message was not found");
      const saved = { ...store.messages[index]!, content };
      store.messages[index] = saved;
      return saved;
    },
  };
  return store;
}

function memoryImageStore(): ChatImageStore {
  const data = new Map<string, string>();
  return {
    async persist(images) {
      return images.map((image) => {
        if (image.data) data.set(image.id, image.data);
        const { data: _data, ...stored } = image;
        const extension = image.mediaType === "image/jpeg"
          ? "jpg"
          : image.mediaType.split("/")[1];
        return { ...stored, path: image.path ?? `chat-images/${image.id}.${extension}` };
      });
    },
    async readBase64(image) {
      return image.data ?? data.get(image.id) ?? "";
    },
    async delete() {},
  };
}

describe("LocalChatSession", () => {
  it("regenerates an assistant reply in place without duplicating the user message", async () => {
    const store = memoryStore([
      message(0, "user", "原问题"),
      message(1, "assistant", "旧回答"),
      message(2, "user", "后续问题"),
      message(3, "assistant", "后续回答"),
    ]);
    const runtime = {
      stream: vi.fn(async function* () {
        yield event("run_finished", { output: "新回答" });
      }),
    };
    store.compressions.push({
      id: "old-summary",
      conversationId: "c1",
      throughSequence: 3,
      summary: "包含旧回答的摘要",
      sourceTokenCount: 100,
      summaryTokenCount: 10,
      status: "completed",
      createdAt: 1,
      updatedAt: 1,
    });

    const result = await new LocalChatSession("c1", runtime, store).regenerate("m1");

    expect(result.user.id).toBe("m0");
    expect(result.assistant.id).toBe("m1");
    expect(result.assistant.content).toBe("新回答");
    expect(store.messages).toHaveLength(4);
    expect(store.messages.map((item) => item.content)).toEqual([
      "原问题", "新回答", "后续问题", "后续回答",
    ]);
    const prompt = runtime.stream.mock.calls[0]?.[1] as string;
    expect(prompt).toContain("用户：原问题");
    expect(prompt).not.toContain("旧回答");
    expect(prompt).not.toContain("后续问题");
    expect(store.compressions[0]?.status).toBe("stale");
  });

  it("compresses old messages, persists the rolling summary, and sends only summary plus tail", async () => {
    const oldestMarker = `最旧需求-A-${"旧".repeat(700)}`;
    const oldAnswerMarker = `最旧回答-B-${"答".repeat(700)}`;
    const store = memoryStore([
      message(0, "user", oldestMarker),
      message(1, "assistant", oldAnswerMarker),
    ]);
    const runtime = {
      stream: vi.fn(async function* (_flowId: string, input: unknown) {
        if (String(input).includes("你是对话上下文压缩器")) {
          yield event(
            "stream_delta",
            { text: "### 关键信息\n- 用户有一项较早需求" },
            { nodeId: "chat_model" },
          );
          yield event("run_finished", { output: "" });
          return;
        }
        yield event("run_finished", { output: "主回答" });
      }),
    };

    const result = await new LocalChatSession(
      "c1",
      runtime,
      store,
      undefined,
      undefined,
      undefined,
      { getModelContextWindow: () => 4_096 },
    ).send("当前问题");

    expect(result.assistant.content).toBe("主回答");
    expect(runtime.stream).toHaveBeenCalledTimes(2);
    const compressionPrompt = String(runtime.stream.mock.calls[0]?.[1]);
    const mainPrompt = String(runtime.stream.mock.calls[1]?.[1]);
    expect(compressionPrompt).toContain("最旧需求-A");
    expect(compressionPrompt).toContain("最旧回答-B");
    expect(mainPrompt).toContain("<compressed_history_summary>");
    expect(mainPrompt).toContain("用户有一项较早需求");
    expect(mainPrompt).toContain("用户：当前问题");
    expect(mainPrompt).not.toContain(oldestMarker);
    expect(mainPrompt).not.toContain(oldAnswerMarker);
    expect(store.compressions).toEqual([
      expect.objectContaining({
        throughSequence: 1,
        status: "completed",
        summary: "### 关键信息\n- 用户有一项较早需求",
      }),
    ]);
  });

  it("updates an existing rolling summary when newly accumulated history crosses the budget", async () => {
    const store = memoryStore([
      message(0, "user", "已经压缩的旧问题"),
      message(1, "assistant", "已经压缩的旧回答"),
      message(2, "user", `新增长问题-${"问".repeat(700)}`),
      message(3, "assistant", `新增长回答-${"答".repeat(700)}`),
    ]);
    store.compressions.push({
      id: "summary-1",
      conversationId: "c1",
      throughSequence: 1,
      summary: "既有摘要：用户选择 SQLite",
      sourceTokenCount: 1_500,
      summaryTokenCount: 20,
      status: "completed",
      createdAt: 1,
      updatedAt: 1,
    });
    const runtime = {
      stream: vi.fn(async function* (_flowId: string, input: unknown) {
        if (String(input).includes("你是对话上下文压缩器")) {
          yield event("run_finished", { output: "更新摘要：SQLite；新增约束已记录" });
          return;
        }
        yield event("run_finished", { output: "继续回答" });
      }),
    };

    await new LocalChatSession(
      "c1",
      runtime,
      store,
      undefined,
      undefined,
      undefined,
      { getModelContextWindow: () => 4_096 },
    ).send("继续");

    const compressionPrompt = String(runtime.stream.mock.calls[0]?.[1]);
    const mainPrompt = String(runtime.stream.mock.calls[1]?.[1]);
    expect(compressionPrompt).toContain("既有摘要：用户选择 SQLite");
    expect(compressionPrompt).toContain("新增长问题");
    expect(mainPrompt).toContain("更新摘要：SQLite；新增约束已记录");
    expect(mainPrompt).not.toContain("新增长问题");
    expect(store.compressions.at(-1)).toEqual(expect.objectContaining({
      throughSequence: 3,
      status: "completed",
    }));
  });

  it("records a failed compression and deterministically drops the oldest tail before answering", async () => {
    const oldestMarker = `应被裁剪-${"旧".repeat(700)}`;
    const recentMarker = `应当保留-${"近".repeat(700)}`;
    const store = memoryStore([
      message(0, "user", oldestMarker),
      message(1, "assistant", recentMarker),
    ]);
    const runtime = {
      stream: vi.fn(async function* (_flowId: string, input: unknown) {
        if (String(input).includes("你是对话上下文压缩器")) {
          yield event("run_failed", { error: { message: "summary provider failed" } });
          return;
        }
        yield event("run_finished", { output: "降级后回答" });
      }),
    };
    const activities: string[] = [];

    await new LocalChatSession(
      "c1",
      runtime,
      store,
      undefined,
      undefined,
      undefined,
      { getModelContextWindow: () => 4_096 },
    ).send("当前问题", {
      onActivity: (activity) => activities.push(activity.label),
    });

    const mainPrompt = String(runtime.stream.mock.calls[1]?.[1]);
    expect(mainPrompt).not.toContain(oldestMarker);
    expect(mainPrompt).toContain(recentMarker);
    expect(mainPrompt).toContain("当前问题");
    expect(store.compressions).toEqual([
      expect.objectContaining({
        status: "failed",
        error: "summary provider failed",
      }),
    ]);
    expect(activities).toContain("已裁剪超出窗口的较早内容");
  });

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

  it("persists a Flow failure as a retryable assistant message without saving partial output", async () => {
    const store = memoryStore();
    store.finishAssistantRun = vi.fn(store.finishAssistantRun);
    const runtime = {
      async *stream() {
        yield event("stream_delta", { text: "半" }, { nodeId: "chat_model" });
        yield event("run_failed", { error: { message: "provider unavailable" } });
      },
    };

    const result = await new LocalChatSession("c1", runtime, store).send("测试");

    expect(result.failed).toBe(true);
    expect(result.assistant.content).toEqual({
      type: "assistant",
      text: "provider unavailable",
      reasoning: "",
      failed: true,
    });
    expect(store.messages.map((item) => item.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(store.messages)).not.toContain("半");
    expect(store.finishAssistantRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: "failed",
        runtimeRunId: "run-1",
        assistantMessageId: result.assistant.id,
      }),
    );
  });

  it("keeps a successful deterministic fallback after a handled node error", async () => {
    const store = memoryStore();
    const runtime = {
      async *stream() {
        yield event("node_error", {
          error: { message: "blueprint planner unavailable" },
        }, { nodeId: "blueprint_planner" });
        yield event("run_finished", {
          output: "## 完整配置表\n\n系统已使用确定性蓝图完成报告。",
        });
      },
    };

    const result = await new LocalChatSession("c1", runtime, store).send("给我一套配置");

    expect(result.failed).toBeUndefined();
    expect(result.assistant.content).toBe("## 完整配置表\n\n系统已使用确定性蓝图完成报告。");
  });

  it("retries a failed assistant message in place and replaces it with the successful answer", async () => {
    const store = memoryStore();
    let attempt = 0;
    const runtime = {
      async *stream() {
        attempt += 1;
        if (attempt === 1) {
          yield event("run_failed", { error: { message: "temporary failure" } });
          return;
        }
        yield event("run_finished", { output: "重试成功" });
      },
    };
    const session = new LocalChatSession("c1", runtime, store);

    const failed = await session.send("请执行");
    const retried = await session.regenerate(failed.assistant.id);

    expect(failed.failed).toBe(true);
    expect(retried.failed).toBeUndefined();
    expect(retried.assistant.id).toBe(failed.assistant.id);
    expect(retried.assistant.content).toBe("重试成功");
    expect(store.messages.map((item) => [item.role, item.content])).toEqual([
      ["user", "请执行"],
      ["assistant", "重试成功"],
    ]);
  });

  it("does not send a persisted Flow error back to the model as conversation context", () => {
    const prompt = buildChatPrompt([
      message(0, "user", "第一次请求"),
      message(1, "assistant", {
        type: "assistant",
        text: "provider unavailable",
        reasoning: "",
        failed: true,
      }),
      message(2, "user", "换个问题"),
    ]);

    expect(prompt).toContain("用户：第一次请求");
    expect(prompt).toContain("用户：换个问题");
    expect(prompt).not.toContain("provider unavailable");
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

    await new LocalChatSession(
      "c1",
      runtime,
      store,
      undefined,
      undefined,
      memoryImageStore(),
    ).send("这是什么？", { images: [image] });

    expect(store.messages[0]?.content).toEqual({
      type: "multimodal",
      text: "这是什么？",
      images: [{
        id: "image-1",
        name: "square.png",
        mediaType: "image/png",
        bytes: 5,
        path: "chat-images/image-1.png",
      }],
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

    await new LocalChatSession(
      "c1",
      runtime,
      store,
      webSearch,
      undefined,
      memoryImageStore(),
    ).send("", {
      images: [image],
      webSearch: true,
    });

    expect(webSearch.searchWeb).not.toHaveBeenCalled();
    expect(store.messages[0]?.content).toMatchObject({
      text: "",
      images: [{ path: "chat-images/image-1.webp" }],
    });
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

  it("passes the conversation model and Flow overrides as run variables without changing the Flow", async () => {
    const store = memoryStore();
    store.getConversation = vi.fn(async () => ({
      id: "c1",
      title: "",
      providerId: "openai",
      modelId: "model-b",
      flowVariables: {
        LLM_FLOW_MAX_OUTPUT_TOKENS: 16384,
        FEATURE_MODE: "precise",
      },
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
        envOverrides: { variables: {
          LLM_FLOW_MAX_OUTPUT_TOKENS: 16384,
          FEATURE_MODE: "precise",
          LLM_DEFAULT_MODEL: "model-b",
        } },
      }),
    );
  });

  it("adds bounded SearXNG results to the prompt when联网 is enabled", async () => {
    const store = memoryStore();
    const runtime = {
      stream: vi.fn(async function* (flowId: string) {
        yield event("run_finished", {
          output: flowId === "builtin_web_search_planner"
            ? JSON.stringify({ queries: ["NKG AI Bot 最新发布", "NKG AI Bot release notes"] })
            : "带来源的回答",
        });
      }),
    };
    const webSearch = {
      searchWeb: vi.fn(async (query: string) => query.includes("release notes")
        ? [{
            title: "Release notes mirror",
            url: "https://mirror.example.test/releases/1",
            content: "Mirrored release notes.",
          }]
        : [{
            title: "Release notes",
            url: "https://example.test/releases/1",
            content: "Version 1 was released today.",
            engine: "bing",
          }]),
    };

    const activities: string[] = [];
    const reportedReferences: unknown[] = [];
    const result = await new LocalChatSession("c1", runtime, store, webSearch).send("今天发布了吗？", {
      webSearch: true,
      onActivity: (activity) => activities.push(activity.kind),
      onSearchResults: (references) => reportedReferences.push(...references),
    });

    expect(webSearch.searchWeb).toHaveBeenNthCalledWith(
      1,
      "NKG AI Bot 最新发布",
      expect.objectContaining({ maxResults: 4 }),
    );
    expect(webSearch.searchWeb).toHaveBeenNthCalledWith(
      2,
      "NKG AI Bot release notes",
      expect.objectContaining({ maxResults: 4 }),
    );
    expect(runtime.stream).toHaveBeenNthCalledWith(
      1,
      "builtin_web_search_planner",
      expect.stringContaining("今天发布了吗？"),
      expect.objectContaining({ flowVersion: "1.0.0" }),
    );
    const prompt = runtime.stream.mock.calls[1]?.[1] as string;
    expect(prompt).toContain("[1] Release notes");
    expect(prompt).toContain("来源：https://example.test/releases/1");
    expect(prompt).toContain("不可信外部内容");
    expect(prompt).toContain("不得编造来源");
    expect(activities[0]).toBe("searching-web");
    expect(activities).toContain("thinking");
    expect(reportedReferences).toEqual([expect.objectContaining({
      title: "Release notes",
      url: "https://example.test/releases/1",
    }), expect.objectContaining({
      title: "Release notes mirror",
      url: "https://mirror.example.test/releases/1",
    })]);
    expect(result.assistant.content).toEqual(expect.objectContaining({
      type: "assistant",
      references: expect.arrayContaining([expect.objectContaining({
        title: "Release notes",
        url: "https://example.test/releases/1",
      }), expect.objectContaining({
        title: "Release notes mirror",
        url: "https://mirror.example.test/releases/1",
      })]),
    }));
  });

  it("skips SearXNG when the planner decides the request needs no external facts", async () => {
    const store = memoryStore();
    const runtime = {
      stream: vi.fn(async function* (flowId: string) {
        yield event("run_finished", {
          output: flowId === "builtin_web_search_planner"
            ? '{"queries":[]}'
            : "改写结果",
        });
      }),
    };
    const webSearch = { searchWeb: vi.fn(async () => []) };

    const result = await new LocalChatSession("c1", runtime, store, webSearch).send("把这句话改得更自然", {
      webSearch: true,
    });

    expect(webSearch.searchWeb).not.toHaveBeenCalled();
    expect(runtime.stream).toHaveBeenCalledTimes(2);
    expect(result.assistant.content).toBe("改写结果");
  });

  it("falls back to the bounded user request when query planning fails", async () => {
    const store = memoryStore();
    const runtime = {
      stream: vi.fn(async function* (flowId: string) {
        yield event("run_finished", {
          output: flowId === "builtin_web_search_planner" ? "not-json" : "回答",
        });
      }),
    };
    const webSearch = { searchWeb: vi.fn(async () => []) };

    await new LocalChatSession("c1", runtime, store, webSearch).send("查询 Steam 2026 上架要求", {
      webSearch: true,
    });

    expect(webSearch.searchWeb).toHaveBeenCalledWith(
      "查询 Steam 2026 上架要求",
      expect.objectContaining({ maxResults: 4 }),
    );
  });

  it("forces current model discovery for the computer advisor when the planner returns no queries", async () => {
    const store = memoryStore();
    const computerSkill: AssistantSkillVersion = {
      ...defaultSkill,
      assistantId: COMPUTER_CONFIG_ASSISTANT_ID,
      name: "电脑配置顾问",
      flowId: "computer_config_advisor",
      memoryNamespace: "assistant:computer_config_advisor",
    };
    store.resolveAssistantSkill = vi.fn(async () => computerSkill);
    const runtime = {
      stream: vi.fn(async function* (flowId: string) {
        yield event("run_finished", {
          output: flowId === "builtin_web_search_planner" ? '{"queries":[]}' : "配置结果",
        });
      }),
    };
    const webSearch = {
      searchWeb: vi.fn(async (query: string) => [{
        title: query,
        url: `https://hardware.example.test/${encodeURIComponent(query)}`,
        content: "current hardware model evidence",
      }]),
    };

    await new LocalChatSession("c1", runtime, store, webSearch).send(
      "预算 8000 元，帮我配一台 2K 游戏电脑",
      { webSearch: true },
    );

    expect(webSearch.searchWeb).toHaveBeenCalledTimes(3);
    expect(webSearch.searchWeb.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      expect.stringContaining("CPU 显卡 具体型号"),
      expect.stringContaining("桌面处理器 当前型号"),
      expect.stringContaining("桌面显卡 当前型号"),
    ]));
    const plannerPrompt = runtime.stream.mock.calls[0]?.[1] as string;
    expect(plannerPrompt).toContain("电脑硬件专项规则");
    const advisorPrompt = runtime.stream.mock.calls[1]?.[1] as string;
    expect(advisorPrompt).toContain("current hardware model evidence");
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
