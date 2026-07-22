import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("chat-first UI consistency", () => {
  it("keeps the app focused on chat plus model and web search settings", async () => {
    const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

    expect(source).toContain('lazy(() => import("./ChatPage")');
    expect(source).toContain("<ProviderSettings");
    expect(source).toContain('aria-label="应用设置"');
    expect(source).not.toContain("运行时基座");
    expect(source).not.toContain("角色");
    expect(source).not.toContain("助理");
  });

  it("keeps affiliate configuration inside the computer configuration Flow", async () => {
    const source = await readFile(new URL("../src/ProviderSettings.tsx", import.meta.url), "utf8");

    expect(source).not.toContain('id: "commerce"');
    expect(source).not.toContain("商品推荐与返利");
    expect(source).not.toContain("保存返利设置");
  });

  it("keeps the chat chrome free of redundant brand tiles", async () => {
    const source = await readFile(new URL("../src/ChatPage.tsx", import.meta.url), "utf8");

    expect(source).not.toContain('className="sidebar-brand"');
    expect(source).not.toContain('className="brand-orb">N</span>');
    expect(source).not.toContain('className="assistant-avatar">');
  });

  it("uses the generated application icon in the custom desktop title bar", async () => {
    const source = await readFile(new URL("../src/AppTitleBar.tsx", import.meta.url), "utf8");
    const icon = await readFile(new URL("../src-tauri/icons/icon.png", import.meta.url));

    expect(source).toContain('import appIcon from "../src-tauri/icons/64x64.png"');
    expect(source).toContain('<img alt="" aria-hidden="true" src={appIcon} />');
    expect(icon.readUInt32BE(16)).toBe(512);
    expect(icon.readUInt32BE(20)).toBe(512);
  });

  it("keeps the conversation header on one compact line", async () => {
    const source = await readFile(new URL("../src/ChatPage.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("../src/App.css", import.meta.url), "utf8");

    expect(source).toContain('className="chat-header-summary"');
    expect(source).toContain('className="chat-header-meta"');
    expect(source).toContain('SIDEBAR_COLLAPSED_STORAGE_KEY');
    expect(source).toContain('sidebar-collapse-toggle');
    expect(source).not.toContain('assistantVersion ?? "1.0.0"');
    expect(styles).toContain("height: 44px; min-height: 44px");
  });

  it("keeps complete migration inside the settings navigation", async () => {
    const settings = await readFile(new URL("../src/ProviderSettings.tsx", import.meta.url), "utf8");
    const migration = await readFile(new URL("../src/DataMigrationSettings.tsx", import.meta.url), "utf8");
    expect(settings).toContain('{ id: "data", label: "数据迁移"');
    expect(settings).toContain("<DataMigrationSettings />");
    expect(migration).toContain("一键迁移全部应用数据");
    expect(migration).toContain("备份当前数据并导入");
  });

  it("asks for a Skill before creating a global conversation and defaults to NKG", async () => {
    const source = await readFile(new URL("../src/ChatPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("setNewConversationOpen(true)");
    expect(source).toContain("setNewConversationSkillId(DEFAULT_ASSISTANT_ID)");
    expect(source).toContain("选择这个对话要使用的 Skill，默认使用 NKG。");
    expect(source).toContain("void startConversation(assistantId)");
  });

  it("loads Runtime on demand and implements the core conversation interactions", async () => {
    const source = await readFile(new URL("../src/ChatPage.tsx", import.meta.url), "utf8");

    expect(source).toContain('import("./runtime")');
    expect(source).not.toContain('from "./runtime"');
    expect(source).toContain("listConversations()");
    expect(source).toContain("deleteConversation(id)");
    expect(source).toContain('event.key === "Enter" && !event.shiftKey');
    expect(source).toContain("abortRef.current?.abort()");
    expect(source).not.toContain("scrollIntoView");
    expect(source).toContain("messageScroll.scrollTo");
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
