import { describe, expect, it, vi } from "vitest";
import {
  createTauriRuntimeServices,
  createTauriSidecarLauncher,
  type TauriInvoke,
} from "../src/index.js";

describe("createTauriSidecarLauncher", () => {
  it("maps lifecycle calls to narrow Tauri commands", async () => {
    const invokeMock = vi.fn(async (command: string) => {
      if (command === "runtime_sidecar_start") {
        return { baseUrl: "http://127.0.0.1:43210", token: "token" };
      }
      return undefined;
    });
    const invoke = invokeMock as unknown as TauriInvoke;
    const launcher = createTauriSidecarLauncher({ invoke });

    await expect(launcher.start()).resolves.toEqual({
      baseUrl: "http://127.0.0.1:43210",
      token: "token",
    });
    await launcher.stop();

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "runtime_sidecar_start",
      "runtime_sidecar_stop",
    ]);
  });
});

describe("createTauriRuntimeServices", () => {
  it("never invokes sidecar commands on iOS", async () => {
    const invoke = vi.fn() as TauriInvoke;
    const services = createTauriRuntimeServices({
      platform: "ios",
      invoke,
      createMobileHandler: () => async () => Response.json({ events: [] }),
    });

    await services.client.getEvents("run-1");

    expect(invoke).not.toHaveBeenCalled();
    expect(services.router.snapshot.backend).toBe("in-process");
  });

  it("starts and authenticates the sidecar on Windows", async () => {
    const invokeMock = vi.fn(async (command: string) => {
      if (command === "runtime_sidecar_start") {
        return { baseUrl: "http://127.0.0.1:43210", token: "desktop-token" };
      }
      return undefined;
    });
    const invoke = invokeMock as unknown as TauriInvoke;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer desktop-token");
      return Response.json({ events: [] });
    });
    const services = createTauriRuntimeServices({
      platform: "windows",
      invoke,
      fetch,
      createMobileHandler: () => { throw new Error("mobile should not boot"); },
    });

    await services.client.getEvents("run-1");
    await services.router.stop();

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "runtime_sidecar_start",
      "runtime_sidecar_stop",
    ]);
  });
});
