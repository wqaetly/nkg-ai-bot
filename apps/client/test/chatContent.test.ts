import { describe, expect, it } from "vitest";
import {
  chatImageDataUrl,
  chatMessageImages,
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

  it("stores image metadata and base64 without losing the message text", async () => {
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
