import { describe, expect, it } from "vitest";
import {
  chatImageDataUrl,
  chatMessageImages,
  chatMessageReferences,
  chatMessageReasoning,
  chatMessageSummary,
  chatMessageText,
  createAssistantMessageContent,
  createChatMessageContent,
  filesToChatImages,
} from "../src/chatContent";

describe("chat multimodal content", () => {
  it("keeps legacy text messages as strings", () => {
    expect(createChatMessageContent(" hello ")).toBe("hello");
    expect(chatMessageText("hello")).toBe("hello");
    expect(chatMessageImages("hello")).toEqual([]);
  });

  it("keeps model reasoning separate from the answer text", () => {
    const content = createAssistantMessageContent(" **答案** ", " 先分析，再回答。 ");

    expect(content).toEqual({
      type: "assistant",
      text: "**答案**",
      reasoning: "先分析，再回答。",
    });
    expect(chatMessageText(content)).toBe("**答案**");
    expect(chatMessageReasoning(content)).toBe("先分析，再回答。");
    expect(chatMessageSummary(content)).toBe("**答案**");
  });

  it("stores safe, unique web references with the assistant answer", () => {
    const content = createAssistantMessageContent("带来源的答案", "", [
      { title: "Release notes", url: "https://example.test/releases/1", snippet: "Version 1 released." },
      { title: "Duplicate", url: "https://example.test/releases/1" },
      { title: "Unsafe", url: "javascript:alert(1)" },
    ]);

    expect(chatMessageText(content)).toBe("带来源的答案");
    expect(chatMessageReasoning(content)).toBe("");
    expect(chatMessageReferences(content)).toEqual([{
      title: "Release notes",
      url: "https://example.test/releases/1",
      snippet: "Version 1 released.",
    }]);
  });

  it("prepares image metadata and base64 without losing the message text", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "sample.png", { type: "image/png" });
    const [image] = await filesToChatImages([file]);
    const content = createChatMessageContent("请描述", [image!]);

    expect(chatMessageText(content)).toBe("请描述");
    expect(chatMessageImages(content)).toEqual([expect.objectContaining({
      name: "sample.png",
      mediaType: "image/png",
      data: "AQID",
      bytes: 3,
    })]);
    expect(chatMessageSummary(content)).toContain("[图片：sample.png]");
    expect(chatImageDataUrl(image!)).toBe("data:image/png;base64,AQID");
  });

  it("rejects unsupported chat image formats", async () => {
    const file = new File(["gif"], "animated.gif", { type: "image/gif" });
    await expect(filesToChatImages([file])).rejects.toThrow("PNG、JPEG 或 WebP");
  });
});
