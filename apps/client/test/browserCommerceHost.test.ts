import { describe, expect, it, vi } from "vitest";
import { withBrowserCommerce } from "../src/browserCommerceHost";
import { BROWSER_COMMERCE_ENDPOINT } from "@nkg-ai-bot/commerce-flow";
import type { TauriInvoke } from "@nkg-ai-bot/tauri-runtime-adapter";

const post = (body: unknown, signal?: AbortSignal) => ({ method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
describe("local commerce browser bridge", () => {
  it("never sends the reserved browser endpoint to the network", async () => {
    const network = vi.fn();
    const invoke = vi.fn(async () => ({ status: "ok", products: [] }));
    const fetch = withBrowserCommerce(network, invoke as TauriInvoke, true);
    expect((await fetch(BROWSER_COMMERCE_ENDPOINT, post({ provider: "taobao", keyword: "RTX 4060" }))).ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("commerce_browser_collect", expect.objectContaining({ provider: "taobao", keyword: "RTX 4060" }));
    expect(network).not.toHaveBeenCalled();
    await fetch("https://example.test/data");
    expect(network).toHaveBeenCalledOnce();
  });
  it("rejects cross-platform detail URLs before opening a native window", async () => {
    const invoke = vi.fn();
    const fetch = withBrowserCommerce(vi.fn(), invoke, true);
    expect((await fetch(BROWSER_COMMERCE_ENDPOINT, post({ provider: "pdd", url: "https://item.jd.com/123.html" }))).status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("reports mobile as unsupported without losing the rest of a flow", async () => {
    const invoke = vi.fn();
    const response = await withBrowserCommerce(vi.fn(), invoke, false)(BROWSER_COMMERCE_ENDPOINT, post({ provider: "jd", keyword: "cpu" }));
    expect(await response.json()).toMatchObject({ status: "unsupported" });
    expect(invoke).not.toHaveBeenCalled();
  });
  it("cancels the native browser when a flow is stopped", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const invoke = vi.fn((command: string) => {
      if (command === "commerce_browser_collect") { started(); return new Promise(() => {}); }
      return Promise.resolve();
    });
    const controller = new AbortController();
    const pending = withBrowserCommerce(vi.fn(), invoke as TauriInvoke, true)(BROWSER_COMMERCE_ENDPOINT, post({ provider: "jd", keyword: "cpu" }, controller.signal));
    await ready;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).toHaveBeenCalledWith("commerce_browser_cancel", expect.objectContaining({ requestId: expect.any(String) }));
  });
});
