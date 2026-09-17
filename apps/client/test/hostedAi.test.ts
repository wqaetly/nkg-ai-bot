import { describe, expect, it, vi } from "vitest";
import { HostedAiApiError, HostedAiClient } from "../src/hostedAi";

const balance = {
  availablePoints: 980,
  purchasedPoints: 800,
  grantedPoints: 180,
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const model = {
  id: "nkg-fast",
  name: "NKG Fast",
  contextWindow: 128_000,
  inputPointsPerMillionTokens: 100,
  outputPointsPerMillionTokens: 500,
  capabilities: ["text", "vision"],
};

describe("HostedAiClient", () => {
  it("creates an anonymous account without exposing a permanent gateway credential", async () => {
    const request = vi.fn(async () => json({ data: {
      accountId: "account-1",
      appAccountToken: "4dc0c81e-8604-4c10-8e3c-21d363e1702b",
      sessionToken: "session-secret-token",
      sessionExpiresAt: "2026-09-01T00:00:00.000Z",
      recoveryToken: `nkg_recover_${"r".repeat(43)}`,
      balance,
      models: [model],
      pointPacks: [{
        id: "points-600",
        points: 600,
        appleProductId: "top.lfzxb.nkg.points600",
        featured: true,
      }],
    } }));
    const client = new HostedAiClient("https://api.example.test", request);

    await expect(client.startAnonymousSession({
      installationId: "b130c491-0f3a-4491-a30a-7a281026a42b",
      platform: "ios",
      appVersion: "0.1.0",
    })).resolves.toMatchObject({
      accountId: "account-1",
      sessionToken: "session-secret-token",
      recoveryToken: `nkg_recover_${"r".repeat(43)}`,
      balance: { availablePoints: 980 },
      models: [{ id: "nkg-fast", capabilities: ["text", "vision"] }],
      pointPacks: [{ points: 600, appleProductId: "top.lfzxb.nkg.points600" }],
    });
    expect(request).toHaveBeenCalledWith(
      new URL("https://api.example.test/api/app/v1/sessions/anonymous"),
      expect.objectContaining({
        method: "POST",
        headers: expect.not.objectContaining({ Authorization: expect.anything() }),
      }),
    );
  });

  it("uses a short-lived run authorization for Runtime environment injection", async () => {
    const request = vi.fn(async () => json({ data: {
      authorizationId: "run-auth-1",
      apiBaseUrl: "https://gateway.example.test/v1/",
      apiKey: "run-scoped-secret",
      expiresAt: "2026-08-01T00:05:00.000Z",
      balance,
    } }));
    const client = new HostedAiClient("https://api.example.test", request);

    const result = await client.createRunOptions("session-secret-token", {
      requestId: "request-1",
      flowId: "builtin.chat",
      modelId: "nkg-fast",
    }, { envOverrides: { variables: { EXISTING: "value" } } });

    expect(result.options).toMatchObject({
      envOverrides: {
        variables: {
          EXISTING: "value",
          LLM_BASE_URL: "https://gateway.example.test/v1",
          LLM_DEFAULT_MODEL: "nkg-fast",
        },
        secrets: { LLM_API_KEY: "run-scoped-secret" },
      },
    });
    expect(request).toHaveBeenCalledWith(
      new URL("https://api.example.test/api/app/v1/runs/authorize"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer session-secret-token",
          "Idempotency-Key": "request-1",
        }),
      }),
    );
  });

  it("redeems signed Apple transactions idempotently without logging transaction contents", async () => {
    const request = vi.fn(async () => json({ data: {
      transactionId: "2000000123456789",
      creditedPoints: 600,
      balance: { ...balance, availablePoints: 1580, purchasedPoints: 1400 },
    } }));
    const client = new HostedAiClient("https://api.example.test", request);
    const signedTransactionInfo = "signed-apple-transaction-payload";

    await expect(client.redeemApplePurchase("session-secret-token", {
      appAccountToken: "4dc0c81e-8604-4c10-8e3c-21d363e1702b",
      signedTransactionInfo,
    })).resolves.toMatchObject({ creditedPoints: 600, balance: { availablePoints: 1580 } });
    const headers = (request.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toMatch(/^apple-[a-f0-9]{8}-32$/);
    expect(headers["Idempotency-Key"]).not.toContain(signedTransactionInfo);
  });

  it("uses the anonymous session for default hosted search", async () => {
    const request = vi.fn(async () => json({ data: [{
      title: "Steam release",
      url: "https://example.test/release",
      content: "Release notes",
      engine: "bing",
    }] }));
    const client = new HostedAiClient("https://api.example.test", request);

    await expect(client.searchWeb("session-secret-token", "Steam release", 3))
      .resolves.toEqual([{
        title: "Steam release",
        url: "https://example.test/release",
        content: "Release notes",
        engine: "bing",
      }]);
    expect(request).toHaveBeenCalledWith(
      new URL("https://api.example.test/api/app/v1/search"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer session-secret-token" }),
        body: JSON.stringify({ query: "Steam release", maxResults: 3 }),
      }),
    );
  });

  it("maps insufficient credit responses to a stable public error", async () => {
    const request = vi.fn(async () => json({ error: { code: "insufficient_points" } }, 402));
    const client = new HostedAiClient("https://api.example.test", request);

    const error = await client.authorizeRun("session-secret-token", {
      requestId: "request-2",
      flowId: "builtin.chat",
      modelId: "nkg-pro",
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HostedAiApiError);
    expect(error).toMatchObject({
      status: 402,
      code: "insufficient_points",
      retryable: false,
      message: "AI 点数不足，请充值后重试",
    });
  });

  it("rejects malformed or unsafe service responses", async () => {
    const request = vi.fn(async () => json({ data: {
      authorizationId: "run-auth-1",
      apiBaseUrl: "http://gateway.example.test/v1",
      apiKey: "run-scoped-secret",
      expiresAt: "2026-08-01T00:05:00.000Z",
      balance,
    } }));
    const client = new HostedAiClient("https://api.example.test", request);

    await expect(client.authorizeRun("session-secret-token", {
      requestId: "request-3",
      flowId: "builtin.chat",
      modelId: "nkg-fast",
    })).rejects.toMatchObject({ code: "invalid_response" });
    expect(() => new HostedAiClient("http://api.example.test"))
      .toThrow("必须使用 HTTPS");
    expect(() => new HostedAiClient("https://secret@api.example.test"))
      .toThrow("不能包含凭据");
  });
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
