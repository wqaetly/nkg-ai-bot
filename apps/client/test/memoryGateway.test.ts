import { describe, expect, it, vi } from "vitest";
import {
  addMemosTurn,
  searchMemosMemories,
} from "../src/memoryGateway";
import type { MemoryServiceConfig } from "../src/storage/database";

const config: MemoryServiceConfig = {
  provider: "memos",
  baseUrl: "https://memory.example.test/api/openmem/v1",
  userId: "user-42",
  apiKeyRef: "memory:memos:api-key",
  enabled: true,
};

describe("MemOS memory gateway", () => {
  it("searches within the project and conversation scope using token auth", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        memory_detail_list: [
          { id: "m1", memory_value: "用户偏好深色主题", relativity: 0.92 },
          { id: "m2", content: "用户偏好深色主题" },
        ],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

    await expect(searchMemosMemories(
      config,
      "secret-key",
      "  主题偏好  ",
      "conversation-1",
      fetchImpl,
      { limit: 3 },
    )).resolves.toEqual([{
      id: "m1",
      content: "用户偏好深色主题",
      relativity: 0.92,
      source: "memos",
    }]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toBe("https://memory.example.test/api/openmem/v1/search/memory");
    expect(init?.headers).toMatchObject({ Authorization: "Token secret-key" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: "主题偏好",
      user_id: "user-42",
      conversation_id: "conversation-1",
      memory_limit_number: 3,
      include_preference: false,
      include_tool_memory: false,
      include_skill: false,
      filter: { and: [{ app_id: "nkg-ai-bot" }] },
    });
  });

  it("writes the completed user and assistant turn asynchronously", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    await addMemosTurn(config, "secret-key", "conversation-1", [
      { role: "user", content: "  请记住我的昵称  " },
      { role: "assistant", content: " 好的，已记住。 " },
    ], fetchImpl);

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toBe("https://memory.example.test/api/openmem/v1/add/message");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      user_id: "user-42",
      conversation_id: "conversation-1",
      async_mode: true,
      messages: [
        { role: "user", content: "请记住我的昵称" },
        { role: "assistant", content: "好的，已记住。" },
      ],
      info: { app_id: "nkg-ai-bot", module: "Chat", scene: "chat" },
    });
  });

  it("returns an actionable authentication error", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    await expect(searchMemosMemories(
      config,
      "bad-key",
      "test",
      "conversation-1",
      fetchImpl,
    )).rejects.toThrow("请检查 API Key 与项目权限");
  });
});
