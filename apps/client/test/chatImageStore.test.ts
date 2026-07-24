import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  migrateLegacyChatImages,
  nativeChatImageStore,
} from "../src/chatImageStore";
import type { DatabaseClient } from "../src/storage/database";

describe("chat image file storage", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("persists image bytes natively and keeps only a relative path in message metadata", async () => {
    invokeMock.mockResolvedValueOnce([{
      id: "image-1",
      path: "chat-images/image-1.png",
    }]);

    const [stored] = await nativeChatImageStore.persist([{
      id: "image-1",
      name: "sample.png",
      mediaType: "image/png",
      bytes: 3,
      data: "AQID",
    }]);

    expect(invokeMock).toHaveBeenCalledWith("save_chat_images", {
      images: [{
        id: "image-1",
        mediaType: "image/png",
        bytes: 3,
        data: "AQID",
      }],
    });
    expect(stored).toEqual({
      id: "image-1",
      name: "sample.png",
      mediaType: "image/png",
      bytes: 3,
      path: "chat-images/image-1.png",
    });
    expect(stored).not.toHaveProperty("data");
  });

  it("rewrites legacy inline message images to file paths", async () => {
    const executions: Array<{ query: string; values?: unknown[] }> = [];
    const database: DatabaseClient = {
      async select<T>() {
        return [{
          id: "message-1",
          content_json: JSON.stringify({
            type: "multimodal",
            text: "看图",
            images: [{
              id: "image-1",
              name: "sample.png",
              mediaType: "image/png",
              bytes: 3,
              data: "AQID",
            }],
          }),
        }] as T;
      },
      async execute(query, values) {
        executions.push({ query, values });
        return { rowsAffected: 1 };
      },
    };
    invokeMock.mockResolvedValueOnce([{
      id: "image-1",
      path: "chat-images/image-1.png",
    }]);

    await expect(migrateLegacyChatImages(database)).resolves.toBe(1);

    const updated = JSON.parse(String(executions[0]?.values?.[1])) as {
      images: Array<Record<string, unknown>>;
    };
    expect(updated.images[0]).toMatchObject({ path: "chat-images/image-1.png" });
    expect(updated.images[0]).not.toHaveProperty("data");
  });
});
