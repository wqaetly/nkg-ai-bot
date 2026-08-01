import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { OfficialAppleTransactionVerifier } from "./apple.js";
import { loadConfig } from "./config.js";
import { CommerceDomainError } from "./domain.js";
import { HostedAiGateway } from "./gateway.js";
import { PostgresCommerceRepository } from "./postgres.js";
import { HostedAiCommerceService } from "./service.js";

const config = await loadConfig();
const repository = new PostgresCommerceRepository(
  config.databaseUrl,
  config.runTokenSecret,
  config.sessionDays,
  config.welcomeGrantPoints,
);
await repository.migrate();
const appleVerifier = new OfficialAppleTransactionVerifier({
  rootCertificates: config.appleRootCertificates,
  bundleId: config.appleBundleId,
  appAppleId: config.appleAppId,
});
const commerce = new HostedAiCommerceService(config, repository, appleVerifier);
const gateway = new HostedAiGateway(config, repository);
const anonymousLimiter = createFixedWindowLimiter(12, 60_000);
const recoveryLimiter = createFixedWindowLimiter(8, 60_000);
const accountLimiter = createFixedWindowLimiter(180, 60_000);
const authorizeLimiter = createFixedWindowLimiter(60, 60_000);
const purchaseLimiter = createFixedWindowLimiter(20, 60_000);
const notificationLimiter = createFixedWindowLimiter(120, 60_000);

const server = createServer(async (request, response) => {
  const requestId = randomUUID();
  response.setHeader("X-Request-ID", requestId);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      await repository.checkHealth();
      sendJson(response, 200, { status: "ready" });
      return;
    }
    const gatewayMatch = /^\/api\/app\/v1\/gateway\/v1(\/.*)$/.exec(url.pathname);
    if (gatewayMatch?.[1]) {
      await gateway.handle(request, response, gatewayMatch[1]);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/app/v1/sessions/anonymous") {
      anonymousLimiter.consume(clientAddress(request));
      sendData(response, 200, await commerce.startAnonymousSession(await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/app/v1/sessions/recover") {
      recoveryLimiter.consume(clientAddress(request));
      sendData(response, 200, await commerce.recoverAnonymousSession(await readJson(request)));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/app/v1/account") {
      accountLimiter.consume(sessionRateKey(request));
      sendData(response, 200, await commerce.getAccount(sessionToken(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/app/v1/runs/authorize") {
      authorizeLimiter.consume(sessionRateKey(request));
      sendData(response, 200, await commerce.authorizeRun(
        sessionToken(request),
        await readJson(request),
        header(request, "idempotency-key"),
      ));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/app/v1/runs/complete") {
      authorizeLimiter.consume(sessionRateKey(request));
      sendData(response, 200, await commerce.completeRun(
        sessionToken(request),
        await readJson(request),
      ));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/app/v1/purchases/apple") {
      purchaseLimiter.consume(sessionRateKey(request));
      sendData(response, 200, await commerce.redeemApplePurchase(
        sessionToken(request),
        await readJson(request, 96 * 1024),
      ));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/app/v1/account/recovery/rotate") {
      purchaseLimiter.consume(sessionRateKey(request));
      sendData(response, 200, await commerce.rotateRecoveryToken(sessionToken(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/app/v1/apple/notifications") {
      notificationLimiter.consume(clientAddress(request));
      sendJson(response, 200, await commerce.handleAppleNotification(
        await readJson(request, 160 * 1024),
      ));
      return;
    }
    throw new CommerceDomainError("not_found", "接口不存在", 404);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : new Error("request failed"));
      return;
    }
    const normalized = normalizeError(error);
    sendJson(response, normalized.status, {
      error: { code: normalized.code, message: normalized.message },
      requestId,
    });
    if (normalized.status >= 500) {
      console.error(JSON.stringify({ requestId, code: normalized.code, message: normalized.internalMessage }));
    }
  }
});

server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 65_000;
server.listen(config.port, "0.0.0.0", () => {
  console.info(JSON.stringify({ event: "hosted_ai_service_started", port: config.port }));
});

async function shutdown(signal: string): Promise<void> {
  console.info(JSON.stringify({ event: "hosted_ai_service_stopping", signal }));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await repository.close();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

function sessionToken(request: IncomingMessage): string {
  const match = /^Bearer\s+(nkg_sess_[A-Za-z0-9_-]+)$/i.exec(request.headers.authorization ?? "");
  if (!match?.[1]) throw new CommerceDomainError("missing_session", "缺少 NKG AI 登录状态", 401);
  return match[1];
}

async function readJson(request: IncomingMessage, maximum = 64 * 1024): Promise<unknown> {
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new CommerceDomainError("unsupported_media_type", "请求必须使用 application/json", 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maximum) throw new CommerceDomainError("request_too_large", "请求体过大", 413);
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    throw new CommerceDomainError("invalid_json", "请求不是有效 JSON", 400);
  }
}

function sendData(response: ServerResponse, status: number, data: unknown): void {
  sendJson(response, status, { data });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function clientAddress(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(",")[0]?.trim().slice(0, 80) || request.socket.remoteAddress || "unknown";
}

function sessionRateKey(request: IncomingMessage): string {
  return createHash("sha256").update(sessionToken(request)).digest("base64url");
}

function normalizeError(error: unknown): {
  status: number; code: string; message: string; internalMessage: string;
} {
  if (error instanceof CommerceDomainError) {
    return { status: error.httpStatus, code: error.code, message: error.message, internalMessage: error.message };
  }
  return {
    status: 500,
    code: "internal_error",
    message: "NKG AI 服务暂时不可用，请稍后重试",
    internalMessage: error instanceof Error ? error.message : String(error),
  };
}

function createFixedWindowLimiter(limit: number, windowMs: number): { consume(key: string): void } {
  const windows = new Map<string, { count: number; expiresAt: number }>();
  return { consume(key: string): void {
    const now = Date.now();
    const current = windows.get(key);
    if (!current || current.expiresAt <= now) {
      windows.set(key, { count: 1, expiresAt: now + windowMs });
      if (windows.size > 20_000) prune(now);
      return;
    }
    current.count += 1;
    if (current.count > limit) {
      throw new CommerceDomainError("rate_limited", "请求过于频繁，请稍后重试", 429);
    }
  } };

  function prune(now: number): void {
    for (const [key, value] of windows) if (value.expiresAt <= now) windows.delete(key);
  }
}
