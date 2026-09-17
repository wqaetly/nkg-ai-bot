import { describe, expect, it, vi } from "vitest";
import { CommerceDomainError } from "../src/domain.js";
import { HostedSearxngSearch } from "../src/search.js";

function setup(fetchImpl: typeof globalThis.fetch) {
  const repository = {
    authenticateSession: vi.fn(async () => ({
      accountId: "05f42572-ddd1-40d2-8d16-d95d23306b75",
      appAccountToken: "4dc0c81e-8604-4c10-8e3c-21d363e1702b",
    })),
  };
  return {
    repository,
    search: new HostedSearxngSearch({
      searxngBaseUrl: "https://search.example.test",
      searxngApiKey: "server-only-secret",
      searchTimeoutMs: 12_000,
      searchMaxResults: 6,
    }, repository, fetchImpl),
  };
}

describe("hosted SearXNG search", () => {
  it("authenticates the anonymous app session and keeps the upstream key server-side", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { title: "Steam release", url: "https://example.test/release", content: "Release notes", engine: "bing" },
        { title: "Duplicate", url: "https://example.test/release", content: "Ignored" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const { repository, search } = setup(request);

    await expect(search.search("nkg_sess_client", {
      query: "Steam release",
      maxResults: 3,
    })).resolves.toEqual([{
      title: "Steam release",
      url: "https://example.test/release",
      content: "Release notes",
      engine: "bing",
    }]);

    expect(repository.authenticateSession).toHaveBeenCalledWith("nkg_sess_client");
    expect(request).toHaveBeenCalledWith(
      new URL("https://search.example.test/search?q=Steam+release&format=json"),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-API-Key": "server-only-secret" }),
      }),
    );
  });

  it("does not expose upstream failures or credentials to the app", async () => {
    const { search } = setup(vi.fn(async () => new Response("secret backend failure", { status: 401 })));

    const error = await search.search("nkg_sess_client", { query: "test" })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CommerceDomainError);
    expect((error as CommerceDomainError).httpStatus).toBe(502);
    expect((error as Error).message).not.toContain("secret");
  });

  it("rejects oversized or malformed client queries before contacting SearXNG", async () => {
    const request = vi.fn();
    const { search } = setup(request as unknown as typeof globalThis.fetch);

    await expect(search.search("nkg_sess_client", { query: "x".repeat(501) }))
      .rejects.toThrow("500");
    expect(request).not.toHaveBeenCalled();
  });
});
