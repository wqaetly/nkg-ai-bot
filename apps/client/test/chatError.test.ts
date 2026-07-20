import { describe, expect, it } from "vitest";
import { RuntimeTransportError } from "@nkg-ai-bot/runtime-router";
import { describeChatError } from "../src/chatError";

describe("describeChatError", () => {
  it("explains why an interrupted stream is not resumed automatically", () => {
    const error = new RuntimeTransportError("cut", {
      backend: "node-sidecar",
      phase: "stream",
      requestMayHaveExecuted: true,
    });

    expect(describeChatError(error)).toContain("不完整回复未保存");
    expect(describeChatError(error)).toContain("不会自动续跑");
  });

  it("uses a local, non-error-looking message for an explicit cancellation", () => {
    expect(describeChatError(new DOMException("cancelled", "AbortError")))
      .toBe("已停止生成，本次不完整回复未保存。");
  });
});
