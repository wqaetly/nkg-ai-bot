import { describe, expect, it, vi } from "vitest";
import {
  cosineSimilarity,
  memoryContentFingerprint,
  rankHybridMemoryItems,
  requestTextEmbeddings,
  searchLocalMemoriesSemantically,
} from "../src/localMemorySearch";
import type { MemoryItem } from "../src/learningRepository";
import type { DatabaseClient } from "../src/storage/database";

function memory(id: string, content: string, updatedAt = 1): MemoryItem {
  return {
    id,
    namespace: "global",
    content,
    confidence: 1,
    status: "active",
    createdAt: 1,
    updatedAt,
  };
}

describe("lightweight local semantic memory", () => {
  it("uses semantic similarity when the query and memory share no literal terms", () => {
    const cat = memory("cat", "用户养了一只英国短毛猫", 2);
    const timezone = memory("timezone", "用户常住上海，使用北京时间", 1);

    const ranked = rankHybridMemoryItems(
      "家里的宠物需要准备什么？",
      [timezone, cat],
      [1, 0],
      new Map([
        [cat.id, [0.98, 0.05]],
        [timezone.id, [0.02, 0.99]],
      ]),
    );

    expect(ranked.map((item) => item.id)).toEqual(["cat"]);
  });

  it("keeps cosine and content fingerprints deterministic", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(memoryContentFingerprint("用户喜欢蓝色"))
      .not.toBe(memoryContentFingerprint("用户喜欢绿色"));
    expect(memoryContentFingerprint("用户喜欢蓝色"))
      .toBe(memoryContentFingerprint("用户喜欢蓝色"));
  });

  it("calls an OpenAI-compatible embeddings endpoint and restores response order", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(requestTextEmbeddings(
      "https://embedding.example.test/v1/",
      "secret",
      "bge-m3",
      ["query", "memory"],
      request,
    )).resolves.toEqual([[1, 0], [0, 1]]);
    expect(request).toHaveBeenCalledWith(
      new URL("https://embedding.example.test/v1/embeddings"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
        body: JSON.stringify({ model: "bge-m3", input: ["query", "memory"] }),
      }),
    );
  });

  it("rejects malformed vectors instead of persisting unusable data", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, Number.NaN] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(requestTextEmbeddings(
      "https://embedding.example.test/v1",
      "secret",
      "bge-m3",
      ["query"],
      request,
    )).rejects.toThrow("无效向量");
  });

  it("pages stored vectors without hiding memories after the former 500 item boundary", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: `memory-${index}`,
      namespace: "global",
      content: index === 500 ? "用户喜欢蓝色" : `普通记忆 ${index}`,
      source_message_id: null,
      confidence: 1,
      status: "active",
      created_at: index,
      updated_at: index,
    }));
    const select = vi.fn(async (query: string) => (
      query.includes("FROM memory_items") ? rows : []
    ));
    const database = {
      select,
      execute: vi.fn(async () => ({ rowsAffected: 0 })),
    } as unknown as DatabaseClient;

    const results = await searchLocalMemoriesSemantically({
      query: "喜欢蓝色",
      namespace: "global",
      modelKey: "local:test",
      maxBackfill: 0,
      embedTexts: vi.fn(async () => [[1, 0]]),
    }, database);

    expect(results.map((item) => item.id)).toContain("memory-500");
    expect(select.mock.calls.filter(([query]) => (
      (query as string).includes("FROM memory_item_embeddings")
    ))).toHaveLength(2);
    expect(select.mock.calls[0]?.[0]).not.toContain("LIMIT");
  });
});
