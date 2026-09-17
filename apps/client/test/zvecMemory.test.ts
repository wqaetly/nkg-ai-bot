import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { memoryContentFingerprint, searchLocalMemoriesSemantically } from "../src/localMemorySearch";
import type { DatabaseClient } from "../src/storage/database";
import { deleteMemoryItem } from "../src/learningRepository";
import { verifyArchive, zvecTarget } from "../../../scripts/zvec-sdk.mjs";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));

it("uses the native index with isolated model/namespace, filters unknown IDs, and falls back on failure", async () => {
  const rows = [
    { id: "cat", content: "用户养了一只英国短毛猫" },
    { id: "timezone", content: "用户常住上海" },
  ].map((row) => ({ ...row, namespace: "assistant-a", confidence: 1, status: "active", created_at: 1, updated_at: 1 }));
  const embeddings = rows.map((row, index) => ({
    memory_id: row.id, model_key: "local-bge", content_fingerprint: memoryContentFingerprint(row.content),
    dimensions: 2, vector_base64: index === 0 ? "AACAPwAAAAA=" : "AAAAAAAAgD8=", updated_at: 1,
  }));
  const database = { select: vi.fn(async (sql: string) => sql.includes("FROM memory_items") ? rows : embeddings),
    execute: vi.fn() } as unknown as DatabaseClient;
  const options = { namespace: "assistant-a", modelKey: "local-bge", query: "宠物", embedTexts: vi.fn(async () => [[1, 0]]) };
  vi.mocked(invoke).mockResolvedValueOnce([{ id: "cat", similarity: 1 }, { id: "deleted", similarity: 1 }]);
  expect((await searchLocalMemoriesSemantically(options, database)).map((row) => row.id)).toEqual(["cat"]);
  expect(invoke).toHaveBeenCalledWith("search_memory_index", {
    request: { namespace: "assistant-a", modelKey: "local-bge", vector: [1, 0], limit: 50,
      records: [{ id: "cat", vector: [1, 0] }, { id: "timezone", vector: [0, 1] }] },
  });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(invoke).mockRejectedValueOnce(new Error("index unavailable"));
  expect((await searchLocalMemoriesSemantically(options, database)).map((row) => row.id)).toEqual(["cat"]);
  expect(warning).toHaveBeenCalled();
  warning.mockRestore();
  let finish!: (hits: Array<{ id: string; similarity: number }>) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = searchLocalMemoriesSemantically(options, database);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  vi.mocked(invoke).mockResolvedValue(undefined);
  await deleteMemoryItem("cat", database);
  finish([{ id: "cat", similarity: 1 }]);
  expect(await pending).toEqual([]);
  expect(invoke).toHaveBeenLastCalledWith("reset_memory_index");
  expect(zvecTarget("android", "aarch64")).toBe("android-arm64");
  expect(zvecTarget("ios", "arm64")).toBe("ios");
  expect(() => zvecTarget("android", "armv7")).toThrow("No pinned zvec SDK");
  expect(() => verifyArchive(Buffer.from("tampered"), "wrong")).toThrow("SHA-256 mismatch");
});
