import { describe, expect, it, vi } from "vitest";
import { createInProcessBackend } from "../src/inProcessBackend.js";
import { createNodeSidecarBackend } from "../src/nodeSidecarBackend.js";

describe("createNodeSidecarBackend", () => {
  it("forwards requests to loopback and injects the startup token", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      return Response.json({
        url: request.url,
        authorization: request.headers.get("authorization"),
      });
    });
    const launcher = {
      start: vi.fn(async () => ({
        baseUrl: "http://127.0.0.1:43123",
        token: "ephemeral-secret",
      })),
      stop: vi.fn(async () => undefined),
    };
    const backend = createNodeSidecarBackend({ launcher, fetch });

    await backend.start();
    const response = await backend.request("/runs/one?limit=1");

    expect(await response.json()).toEqual({
      url: "http://127.0.0.1:43123/runs/one?limit=1",
      authorization: "Bearer ephemeral-secret",
    });
    await backend.stop();
    expect(launcher.stop).toHaveBeenCalledOnce();
  });

  it.each([
    "https://127.0.0.1:43123",
    "http://192.168.1.10:43123",
    "https://example.com",
  ])("refuses unsafe sidecar URL %s", async (baseUrl) => {
    const launcher = {
      start: vi.fn(async () => ({ baseUrl, token: "token" })),
      stop: vi.fn(async () => undefined),
    };
    const backend = createNodeSidecarBackend({ launcher });

    await expect(backend.start()).rejects.toThrow("loopback HTTP URL");
    expect(launcher.stop).toHaveBeenCalledOnce();
  });

  it("refuses absolute request URLs", async () => {
    const backend = createNodeSidecarBackend({
      launcher: {
        start: async () => ({ baseUrl: "http://localhost:43123", token: "token" }),
        stop: async () => undefined,
      },
      fetch: vi.fn(),
    });
    await backend.start();

    await expect(backend.request("https://attacker.example/run")).rejects.toThrow(
      "must start with '/'",
    );
  });
});

describe("createInProcessBackend", () => {
  it("dispatches a real Fetch Request without opening a socket", async () => {
    const seen: Request[] = [];
    const backend = createInProcessBackend({
      createHandler: () => async (request) => {
        seen.push(request);
        return Response.json({ input: await request.json() });
      },
    });
    await backend.start();

    const response = await backend.request("/flows/chat/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(seen[0]?.url).toBe("http://runtime.local/flows/chat/invoke");
    expect(await response.json()).toEqual({ input: { message: "hello" } });
  });

  it("drops the handler on stop", async () => {
    const backend = createInProcessBackend({
      createHandler: () => async () => new Response(null, { status: 204 }),
    });
    await backend.start();
    await backend.stop();

    await expect(backend.request("/health")).rejects.toThrow("not started");
  });
});
