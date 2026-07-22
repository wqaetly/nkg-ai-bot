import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("chat-first UI consistency", () => {
  it("keeps the app focused on chat plus model and web search settings", async () => {
    const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

    expect(source).toContain('lazy(() => import("./ChatPage")');
    expect(source).toContain("<ProviderSettings");
    expect(source).toContain('aria-label="模型与联网设置"');
    expect(source).not.toContain("运行时基座");
    expect(source).not.toContain("角色");
    expect(source).not.toContain("助理");
  });

  it("loads Runtime on demand and implements the core conversation interactions", async () => {
    const source = await readFile(new URL("../src/ChatPage.tsx", import.meta.url), "utf8");

    expect(source).toContain('import("./runtime")');
    expect(source).not.toContain('from "./runtime"');
    expect(source).toContain("listConversations()");
    expect(source).toContain("deleteConversation(id)");
    expect(source).toContain('event.key === "Enter" && !event.shiftKey');
    expect(source).toContain("abortRef.current?.abort()");
    expect(source).toContain("scrollIntoView");
    expect(source).toContain('aria-label="当前对话模型"');
    expect(source).toContain("const value = event.currentTarget.value;");
    expect(source).toContain("[activeId]: value");
    expect(source).not.toContain("[activeId]: event.currentTarget.value");
  });

  it("uses a desktop sidebar and converts it to an off-canvas mobile drawer", async () => {
    const styles = await readFile(new URL("../src/App.css", import.meta.url), "utf8");

    expect(styles).toContain("width: 286px");
    expect(styles).toContain("@media (max-width: 720px)");
    expect(styles).toContain("transform: translateX(-105%)");
    expect(styles).toContain(".conversation-sidebar.open { transform: translateX(0); }");
    expect(styles).toContain("env(safe-area-inset-bottom)");
    expect(styles).toContain(".composer-model-select");
  });

  it("exposes the computer configuration Flow through the selectable skill experience", async () => {
    const source = await readFile(new URL("../src/ChatPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("COMPUTER_CONFIG_ASSISTANT_ID");
    expect(source).toContain("准备配一台怎样的电脑？");
    expect(source).toContain("检查现有配置");
    expect(source).toContain("规划升级路线");
  });
});
