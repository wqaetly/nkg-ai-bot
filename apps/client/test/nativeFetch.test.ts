import { describe, expect, it, vi } from "vitest";
import { getPlatformFetch } from "../src/nativeFetch.js";

const mocks = vi.hoisted(() => ({
  nativeFetch: vi.fn() as unknown as typeof fetch,
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mocks.nativeFetch }));

describe("platform HTTP client", () => {
  it.each(["android", "ios"] as const)(
    "returns the native client on %s without mutating global fetch",
    async (platform) => {
      const original = globalThis.fetch;

      const fetchImpl = await getPlatformFetch(platform);

      expect(fetchImpl).toBe(mocks.nativeFetch);
      expect(globalThis.fetch).toBe(original);
    },
  );

  it("keeps desktop HTTP bound to the host fetch", async () => {
    const original = globalThis.fetch;
    const fetchImpl = await getPlatformFetch("windows");

    expect(globalThis.fetch).toBe(original);
    expect(fetchImpl).not.toBe(mocks.nativeFetch);
  });
});
