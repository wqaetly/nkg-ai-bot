import { describe, expect, it, vi } from "vitest";
import {
  MOBILE_RESUMED_EVENT,
  MOBILE_SUSPENDED_EVENT,
  MobileRuntimeLifecycle,
} from "../src/mobileRuntimeLifecycle";

const healthyCatalog = { total: 2, registered: 2, failures: [] };
const emptySuspension = {
  abortedExecutions: 0,
  cancellationRequests: 0,
  cancellationFailures: [],
};

describe("MobileRuntimeLifecycle", () => {
  it("does not install mobile listeners on desktop platforms", async () => {
    const listen = vi.fn();
    const lifecycle = new MobileRuntimeLifecycle({
      platform: "windows",
      initialCatalog: healthyCatalog,
      listen,
      suspendExecutions: vi.fn(),
      resumeRuntime: vi.fn(),
    });

    await lifecycle.start();

    expect(listen).not.toHaveBeenCalled();
    expect(lifecycle.state.phase).toBe("active");
  });

  it("serialises suspension and resume, then publishes the refreshed catalog", async () => {
    const handlers = new Map<string, () => void>();
    const listen = vi.fn(async (event: string, handler: () => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    });
    const order: string[] = [];
    const degradedCatalog = {
      total: 2,
      registered: 1,
      failures: [{ id: "bad", version: "1", name: "Bad", message: "invalid" }],
    };
    const lifecycle = new MobileRuntimeLifecycle({
      platform: "android",
      initialCatalog: healthyCatalog,
      listen,
      suspendExecutions: async () => {
        order.push("suspend");
        return { ...emptySuspension, abortedExecutions: 1 };
      },
      resumeRuntime: async () => {
        order.push("resume");
        return degradedCatalog;
      },
    });

    await lifecycle.start();
    handlers.get(MOBILE_SUSPENDED_EVENT)?.();
    handlers.get(MOBILE_RESUMED_EVENT)?.();
    await lifecycle.settled();

    expect(order).toEqual(["suspend", "resume"]);
    expect(lifecycle.state).toEqual({ phase: "degraded", catalog: degradedCatalog });
  });

  it("surfaces a resume failure instead of reporting a false ready state", async () => {
    const handlers = new Map<string, () => void>();
    const lifecycle = new MobileRuntimeLifecycle({
      platform: "ios",
      initialCatalog: healthyCatalog,
      listen: async (event, handler) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
      suspendExecutions: async () => emptySuspension,
      resumeRuntime: async () => { throw new Error("runtime restore failed"); },
    });

    await lifecycle.start();
    handlers.get(MOBILE_RESUMED_EVENT)?.();
    await lifecycle.settled();

    expect(lifecycle.state).toMatchObject({
      phase: "failed",
      message: "runtime restore failed",
    });
  });
});
