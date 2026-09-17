import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceConfig } from "../src/config.js";
import { HostedAiGateway, extractUsageFromSseLine, findUsage, prepareBody, requestedModelFromBody } from "../src/gateway.js";
import type { PostgresCommerceRepository } from "../src/postgres.js";
import { createRunToken, verifyRunToken } from "../src/tokens.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("hosted AI gateway boundaries", () => {
  it("forces the authorized model and requests final usage on chat streams", () => {
    const prepared = prepareBody(
      Buffer.from(JSON.stringify({ model: "attacker-model", stream: true, messages: [] })),
      "application/json",
      "nkg-fast",
      "/chat/completions",
    );
    expect(JSON.parse(String(prepared))).toMatchObject({
      model: "nkg-fast",
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("rejects multipart image requests that try to change the authorized model", () => {
    const multipart = (model: string) => Buffer.from(
      `--boundary\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n--boundary--\r\n`,
      "utf8",
    );
    expect(() => prepareBody(multipart("other-model"), "multipart/form-data; boundary=boundary", "nkg-image", "/images/edits"))
      .toThrowError(expect.objectContaining({ code: "model_mismatch" }));
    expect(prepareBody(multipart("nkg-image"), "multipart/form-data; boundary=boundary", "nkg-image", "/images/edits"))
      .toBeInstanceOf(Uint8Array);
    const duplicate = Buffer.from(
      "--boundary\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nnkg-image\r\n"
      + "--boundary\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nother-model\r\n--boundary--\r\n",
    );
    expect(() => prepareBody(duplicate, "multipart/form-data; boundary=boundary", "nkg-image", "/images/edits"))
      .toThrowError(expect.objectContaining({ code: "model_mismatch" }));
  });

  it("extracts OpenAI chat and Responses API usage shapes", () => {
    expect(extractUsageFromSseLine("data: {\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":8}}"))
      .toEqual({ inputTokens: 12, outputTokens: 8 });
    expect(findUsage({ response: { usage: { input_tokens: 20, output_tokens: 5 } } }))
      .toEqual({ inputTokens: 20, outputTokens: 5 });
  });

  it("signs run-scoped tokens and rejects tampering", () => {
    const runId = "48c1c384-013f-402b-ac19-b42bd0dccb37";
    const secret = "s".repeat(32);
    const token = createRunToken(runId, secret);
    expect(verifyRunToken(token, secret)).toBe(runId);
    expect(verifyRunToken(`${token.slice(0, -1)}x`, secret)).toBeUndefined();
    expect(verifyRunToken(token, "t".repeat(32))).toBeUndefined();
  });

  it("allows multiple gateway requests in one workflow and settles each independently", async () => {
    const config = gatewayConfig();
    let requestNumber = 0;
    const repository: Pick<PostgresCommerceRepository,
      "claimGatewayRequest" | "bindGatewayRequestModel" | "markGatewayRequestAccepted"
      | "ensureRunReservation" | "settleGatewayRequest" | "failGatewayRequest"> = {
      claimGatewayRequest: vi.fn(async () => ({
        run: {
          id: "48c1c384-013f-402b-ac19-b42bd0dccb37",
          accountId: "05f42572-ddd1-40d2-8d16-d95d23306b75",
          requestId: "b130c491-0f3a-4491-a30a-7a281026a42b",
          flowId: "workflow.multi-step",
          modelId: "nkg-fast",
          reservedPoints: 50,
          chargedPoints: requestNumber,
          status: "in_progress",
          expiresAt: "2030-08-01T00:05:00.000Z",
        },
        gatewayRequestId: `gateway-${++requestNumber}`,
      })),
      bindGatewayRequestModel: vi.fn(async () => undefined),
      ensureRunReservation: vi.fn(async () => undefined),
      markGatewayRequestAccepted: vi.fn(async () => undefined),
      settleGatewayRequest: vi.fn(async () => ({
        chargedPoints: 1,
        balance: {
          availablePoints: 49,
          purchasedPoints: 0,
          grantedPoints: 99,
          reservedPoints: 49,
          debtPoints: 0,
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      })),
      failGatewayRequest: vi.fn(async () => undefined),
    };
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(["nkg-fast", "nkg-pro"]).toContain(JSON.parse(String(init?.body)).model);
      return new Response(JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      }), { headers: { "Content-Type": "application/json" } });
    });
    const url = await serveGateway(new HostedAiGateway(config, repository, upstream));
    const token = createRunToken("48c1c384-013f-402b-ac19-b42bd0dccb37", config.runTokenSecret);
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: index === 0 ? "nkg-fast" : "nkg-pro", messages: [] }),
      });
      expect(response.status).toBe(200);
    }
    expect(repository.claimGatewayRequest).toHaveBeenCalledTimes(2);
    expect(repository.markGatewayRequestAccepted).toHaveBeenNthCalledWith(1, "gateway-1");
    expect(repository.bindGatewayRequestModel).toHaveBeenNthCalledWith(2, "gateway-2", "nkg-pro");
    expect(repository.ensureRunReservation).toHaveBeenNthCalledWith(2,
      "48c1c384-013f-402b-ac19-b42bd0dccb37", 80);
    expect(repository.settleGatewayRequest).toHaveBeenNthCalledWith(
      2,
      "gateway-2",
      config.models[1],
      { inputTokens: 2, outputTokens: 3 },
    );
    expect(repository.failGatewayRequest).not.toHaveBeenCalled();
  });

  it("fails closed when a successful upstream response omits usage", async () => {
    const config = gatewayConfig();
    const repository = {
      claimGatewayRequest: vi.fn(async () => ({
        run: {
          id: "48c1c384-013f-402b-ac19-b42bd0dccb37",
          accountId: "05f42572-ddd1-40d2-8d16-d95d23306b75",
          requestId: "b130c491-0f3a-4491-a30a-7a281026a42b",
          flowId: "workflow.image",
          modelId: "nkg-fast",
          reservedPoints: 50,
          chargedPoints: 0,
          status: "in_progress" as const,
          expiresAt: "2030-08-01T00:05:00.000Z",
        },
        gatewayRequestId: "gateway-no-usage",
      })),
      bindGatewayRequestModel: vi.fn(async () => undefined),
      ensureRunReservation: vi.fn(async () => undefined),
      markGatewayRequestAccepted: vi.fn(async () => undefined),
      settleGatewayRequest: vi.fn(async () => ({ chargedPoints: 50, balance: {} as never })),
      failGatewayRequest: vi.fn(async () => undefined),
    };
    const gateway = new HostedAiGateway(
      config,
      repository,
      vi.fn(async () => new Response("{}", { headers: { "Content-Type": "application/json" } })),
    );
    const url = await serveGateway(gateway);
    const token = createRunToken("48c1c384-013f-402b-ac19-b42bd0dccb37", config.runTokenSecret);
    expect((await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    })).status).toBe(200);
    expect(repository.settleGatewayRequest).toHaveBeenCalledWith(
      "gateway-no-usage",
      config.models[0],
      undefined,
    );
  });

  it("selects each request model while rejecting malformed multipart model fields", () => {
    expect(requestedModelFromBody(Buffer.from('{"model":"nkg-pro"}'), "application/json", "nkg-fast"))
      .toBe("nkg-pro");
    expect(requestedModelFromBody(Buffer.from("{}"), "application/json", "nkg-fast"))
      .toBe("nkg-fast");
  });
});

function gatewayConfig(): ServiceConfig {
  return {
    port: 8787,
    databaseUrl: "postgres://test",
    publicBaseUrl: "https://api.example.test",
    sessionDays: 30,
    runTtlSeconds: 300,
    welcomeGrantPoints: 0,
    runTokenSecret: "s".repeat(32),
    newApiBaseUrl: "https://new-api.example.test",
    newApiKey: "new-api-secret",
    searxngBaseUrl: "https://search.example.test",
    searxngApiKey: "search-secret",
    searchTimeoutMs: 12_000,
    searchMaxResults: 6,
    appleBundleId: "com.nkg.ai.bot",
    appleAppId: 123456789,
    appleRootCertificates: [],
    models: [{
      id: "nkg-fast",
      name: "NKG Fast",
      contextWindow: 128_000,
      inputPointsPerMillionTokens: 100,
      outputPointsPerMillionTokens: 500,
      reservePoints: 50,
      capabilities: ["text"],
    }, {
      id: "nkg-pro",
      name: "NKG Pro",
      contextWindow: 200_000,
      inputPointsPerMillionTokens: 300,
      outputPointsPerMillionTokens: 1_000,
      reservePoints: 80,
      capabilities: ["text", "reasoning"],
    }],
    pointPacks: [],
  };
}

async function serveGateway(gateway: HostedAiGateway): Promise<string> {
  const server = createServer((request, response) => {
    void gateway.handle(request, response, "/chat/completions").catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
