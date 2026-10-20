import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationFlowConfigDialog } from "../src/ConversationFlowConfigDialog";
import { COMPUTER_CONFIG_FLOW } from "../src/builtinFlows";
import { flowConfigurableVariables } from "../src/conversationFlowConfig";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => [initial, vi.fn()],
}));

function findLoginAction(tree: unknown): (() => void) | undefined {
  if (Array.isArray(tree)) return tree.map(findLoginAction).find(Boolean);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return;
  const props = tree.props as { children?: unknown; onClick?: () => void };
  if (props.children === "打开所选商城 / 登录") return props.onClick;
  return findLoginAction(props.children);
}

describe("marketplace login selection", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("persists the selected platform before opening it, without closing the dialog", async () => {
    let saved = false;
    const onSave = vi.fn(async () => { saved = true; });
    vi.mocked(invoke).mockImplementation(async () => {
      expect(saved).toBe(true);
    });
    const click = findLoginAction(ConversationFlowConfigDialog({
      flowName: "电脑配置顾问", definitions: flowConfigurableVariables(COMPUTER_CONFIG_FLOW),
      values: { COMPUTER_SHOPPING_PLATFORM: "taobao" }, onCancel: vi.fn(), onSave,
    }));
    expect(click).toBeDefined();
    click!();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("commerce_browser_login", { provider: "taobao" }));
    expect(onSave).toHaveBeenCalledWith({ COMPUTER_SHOPPING_PLATFORM: "taobao" }, false);
  });

  it("does not open a different unsaved platform if saving fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("save failed"));
    findLoginAction(ConversationFlowConfigDialog({
      flowName: "电脑配置顾问", definitions: flowConfigurableVariables(COMPUTER_CONFIG_FLOW),
      values: { COMPUTER_SHOPPING_PLATFORM: "jd" }, onCancel: vi.fn(), onSave,
    }))!();
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalled();
  });
});
