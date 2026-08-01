import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function createSessionToken(): string {
  return `nkg_sess_${randomBytes(32).toString("base64url")}`;
}

export function createRecoveryToken(): string {
  return `nkg_recover_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function createRunToken(runId: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(runId, "utf8").digest("base64url");
  return `nkg_run_${runId}.${signature}`;
}

export function verifyRunToken(token: string, secret: string): string | undefined {
  const match = /^nkg_run_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(token);
  if (!match) return undefined;
  const runId = match[1]!;
  const received = Buffer.from(match[2]!, "base64url");
  const expected = createHmac("sha256", secret).update(runId, "utf8").digest();
  return received.length === expected.length && timingSafeEqual(received, expected) ? runId : undefined;
}
