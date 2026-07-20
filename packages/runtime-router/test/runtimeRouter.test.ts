import { describe, expect, it, vi } from "vitest";
import type { RuntimeBackend } from "../src/contracts.js";
import { RuntimeTransportError } from "../src/contracts.js";
import { RuntimeRouter } from "../src/runtimeRouter.js";

function backend(kind: RuntimeBackend["kind"]): RuntimeBackend {
  return {
    kind,
    start: vi.fn(async () => undefined),
    request: vi.fn(async (path: string) => Response.json({ path, kind })),
    stop: vi.fn(async () => undefined),
  };
}

describe("RuntimeRouter", () => {
  it.each(["windows", "macos", "linux"] as const)(
    "routes desktop platform %s to the Node sidecar",
    async (platform) => {
      const desktop = backend("node-sidecar");
      const mobile = backend("in-process");
      const router = new RuntimeRouter({
        platform,
        desktop: () => desktop,
        mobile: () => mobile,
      });

      const response = await router.request("/health");

      expect(await response.json()).toEqual({ path: "/health", kind: "node-sidecar" });
      expect(desktop.start).toHaveBeenCalledOnce();
      expect(mobile.start).not.toHaveBeenCalled();
      expect(router.snapshot).toMatchObject({ state: "ready", backend: "node-sidecar" });
      expect(router.snapshot.generation).toBe(1);
    },
  );

  it.each(["android", "ios"] as const)(
    "routes mobile platform %s to the in-process runtime",
    async (platform) => {
      const desktop = backend("node-sidecar");
      const mobile = backend("in-process");
      const router = new RuntimeRouter({
        platform,
        desktop: () => desktop,
        mobile: () => mobile,
      });

      await router.request("/health");

      expect(mobile.start).toHaveBeenCalledOnce();
      expect(desktop.start).not.toHaveBeenCalled();
      expect(router.snapshot.backend).toBe("in-process");
    },
  );

  it("deduplicates concurrent lazy starts and supports clean restart", async () => {
    const instance = backend("in-process");
    const factory = vi.fn(() => instance);
    const router = new RuntimeRouter({
      platform: "ios",
      desktop: () => backend("node-sidecar"),
      mobile: factory,
    });

    await Promise.all([
      router.request("/one"),
      router.request("/two"),
      router.start(),
    ]);
    expect(factory).toHaveBeenCalledOnce();
    expect(instance.start).toHaveBeenCalledOnce();

    await router.stop();
    expect(instance.stop).toHaveBeenCalledOnce();
    expect(router.snapshot.state).toBe("idle");

    await router.start();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(router.snapshot.generation).toBe(2);
  });

  it("exposes startup failures and can retry", async () => {
    const failed = backend("in-process");
    vi.mocked(failed.start).mockRejectedValueOnce(new Error("boot failed"));
    const healthy = backend("in-process");
    const factory = vi.fn()
      .mockReturnValueOnce(failed)
      .mockReturnValueOnce(healthy);
    const router = new RuntimeRouter({
      platform: "android",
      desktop: () => backend("node-sidecar"),
      mobile: factory,
    });

    await expect(router.start()).rejects.toThrow("boot failed");
    expect(router.snapshot).toMatchObject({ state: "failed" });
    expect(failed.stop).toHaveBeenCalledOnce();

    await expect(router.start()).resolves.toBeUndefined();
    expect(router.snapshot.state).toBe("ready");
  });

  it("rejects a backend whose kind does not match the selected platform", async () => {
    const wrong = backend("in-process");
    const router = new RuntimeRouter({
      platform: "windows",
      desktop: () => wrong,
      mobile: () => wrong,
    });

    await expect(router.start()).rejects.toThrow("Runtime backend mismatch");
  });

  it("invalidates a crashed desktop sidecar without replaying and restarts on the next request", async () => {
    const crashed = backend("node-sidecar");
    vi.mocked(crashed.request).mockRejectedValueOnce(new TypeError("fetch failed"));
    const replacement = backend("node-sidecar");
    const factory = vi.fn()
      .mockReturnValueOnce(crashed)
      .mockReturnValueOnce(replacement);
    const router = new RuntimeRouter({
      platform: "macos",
      desktop: factory,
      mobile: () => backend("in-process"),
    });

    await expect(router.request("/flows/chat/invoke", { method: "POST" }))
      .rejects.toMatchObject({
        name: "RuntimeTransportError",
        code: "runtime.transport_interrupted",
        phase: "request",
        recoverable: true,
        automaticRetry: false,
        requestMayHaveExecuted: true,
      } satisfies Partial<RuntimeTransportError>);
    expect(crashed.request).toHaveBeenCalledOnce();
    expect(crashed.stop).toHaveBeenCalledOnce();
    expect(router.snapshot).toMatchObject({ state: "failed", backend: "node-sidecar" });

    await expect(router.request("/health")).resolves.toBeInstanceOf(Response);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(replacement.start).toHaveBeenCalledOnce();
  });

  it("does not restart a healthy sidecar when the caller aborts a request", async () => {
    const instance = backend("node-sidecar");
    vi.mocked(instance.request).mockRejectedValueOnce(new DOMException("cancelled", "AbortError"));
    const factory = vi.fn(() => instance);
    const router = new RuntimeRouter({
      platform: "windows",
      desktop: factory,
      mobile: () => backend("in-process"),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(router.request("/flows/chat/stream", { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(instance.stop).not.toHaveBeenCalled();
    expect(router.snapshot.state).toBe("ready");
    await router.request("/health");
    expect(factory).toHaveBeenCalledOnce();
  });
});
