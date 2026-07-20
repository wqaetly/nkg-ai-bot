import { describe, expect, it, vi } from "vitest";
import type { NodeEvent } from "@nkg-ai-bot/runtime-router";
import { buildChatPrompt, LocalChatSession, type ChatStore } from "../src/chatSession";
import type { LocalMessage } from "../src/storage/repositories";

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
    async upsertConversation() {},
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
      expect.stringContaining("用户：你好"),
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
    const runtime = {
      async *stream() {
        yield event("stream_delta", { text: "半" }, { nodeId: "chat_model" });
        yield event("run_failed", { error: { message: "provider unavailable" } });
      },
    };

    await expect(new LocalChatSession("c1", runtime, store).send("测试"))
      .rejects.toThrow("provider unavailable");
    expect(store.messages.map((item) => item.role)).toEqual(["user"]);
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
});
