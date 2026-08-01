import { describe, expect, it } from "vitest";
import {
  CommerceDomainError,
  authorizeRun,
  calculateBalance,
  calculateGatewayRequestCharge,
  calculateUsagePoints,
  creditApplePurchase,
  releaseExpiredRuns,
  settleRun,
  type AccountPointState,
  type ModelRate,
  type PointPack,
} from "../src/domain.js";

const model: ModelRate = {
  id: "nkg-fast",
  name: "NKG Fast",
  contextWindow: 128_000,
  inputPointsPerMillionTokens: 100,
  outputPointsPerMillionTokens: 500,
  reservePoints: 50,
  capabilities: ["text"],
};

const pack: PointPack = {
  id: "points-600",
  points: 600,
  appleProductId: "com.nkg.ai.bot.points.600",
  featured: true,
};

function state(): AccountPointState {
  return {
    accountId: "account-1",
    appAccountToken: "4dc0c81e-8604-4c10-8e3c-21d363e1702b",
    ledger: [{
      id: "grant-1",
      accountId: "account-1",
      bucket: "granted",
      kind: "grant",
      pointsDelta: 100,
      referenceType: "promotion",
      referenceId: "welcome",
      createdAt: "2026-08-01T00:00:00.000Z",
    }],
    runs: [],
    appleTransactions: [],
  };
}

describe("hosted AI point domain", () => {
  it("credits each verified Apple transaction exactly once", () => {
    const account = state();
    const transaction = {
      transactionId: "2000000123456789",
      originalTransactionId: "2000000123456789",
      appAccountToken: account.appAccountToken,
      productId: pack.appleProductId,
      environment: "Sandbox" as const,
      purchaseDate: "2026-08-01T00:00:00.000Z",
    };
    expect(creditApplePurchase(account, transaction, pack).credited).toBe(true);
    expect(creditApplePurchase(account, transaction, pack).credited).toBe(false);
    expect(calculateBalance(account)).toMatchObject({ availablePoints: 700, purchasedPoints: 600, grantedPoints: 100 });
    expect(account.ledger.filter((entry) => entry.kind === "purchase")).toHaveLength(1);
  });

  it("rejects a transaction assigned to another NKG account", () => {
    const account = state();
    expect(() => creditApplePurchase(account, {
      transactionId: "tx-other",
      originalTransactionId: "tx-other",
      appAccountToken: "83d94a7d-a0a5-429b-9269-487a2948f974",
      productId: pack.appleProductId,
      environment: "Production",
      purchaseDate: "2026-08-01T00:00:00.000Z",
    }, pack)).toThrowError(expect.objectContaining({ code: "account_token_mismatch" }));
  });

  it("reserves points idempotently and prevents oversubscription", () => {
    const account = state();
    const first = authorizeRun(account, { requestId: "request-1", flowId: "builtin.chat", model, ttlSeconds: 300 });
    const replay = authorizeRun(account, { requestId: "request-1", flowId: "builtin.chat", model, ttlSeconds: 300 });
    expect(replay.run.id).toBe(first.run.id);
    expect(replay.replayed).toBe(true);
    expect(calculateBalance(account).availablePoints).toBe(50);
    authorizeRun(account, { requestId: "request-2", flowId: "builtin.chat", model, ttlSeconds: 300 });
    expect(calculateBalance(account).availablePoints).toBe(0);
    expect(() => authorizeRun(account, { requestId: "request-3", flowId: "builtin.chat", model, ttlSeconds: 300 }))
      .toThrowError(expect.objectContaining({ code: "insufficient_points", httpStatus: 402 }));
  });

  it("settles multiple model calls inside one workflow without exceeding its reservation", () => {
    const account = state();
    const authorization = authorizeRun(account, { requestId: "request-1", flowId: "builtin.chat", model, ttlSeconds: 300 });
    const first = settleRun(account, authorization.run.id, { inputTokens: 10_000, outputTokens: 20_000 }, model);
    expect(calculateUsagePoints({ inputTokens: 10_000, outputTokens: 20_000 }, model)).toBe(11);
    expect(first.run).toMatchObject({ status: "in_progress", chargedPoints: 11 });
    expect(first.balance).toMatchObject({ availablePoints: 50, grantedPoints: 89, reservedPoints: 39 });
    expect(authorizeRun(account, { requestId: "request-1", flowId: "builtin.chat", model, ttlSeconds: 300 }).replayed)
      .toBe(true);
    const second = settleRun(account, authorization.run.id, { inputTokens: 0, outputTokens: 78_000 }, model);
    expect(second.run).toMatchObject({ status: "settled", chargedPoints: 50, outputTokens: 98_000 });
    expect(second.balance).toMatchObject({ availablePoints: 50, grantedPoints: 50, reservedPoints: 0 });
  });

  it("releases expired reservations without minting or spending points", () => {
    const account = state();
    authorizeRun(account, { requestId: "request-1", flowId: "builtin.chat", model, ttlSeconds: 1 }, new Date("2026-08-01T00:00:00.000Z"));
    expect(releaseExpiredRuns(account, new Date("2026-08-01T00:00:02.000Z"))).toBe(1);
    expect(calculateBalance(account, new Date("2026-08-01T00:00:02.000Z")).availablePoints).toBe(100);
  });

  it("fails closed if reported usage exceeds the authorized reservation", () => {
    const account = state();
    const authorization = authorizeRun(account, { requestId: "request-1", flowId: "builtin.chat", model, ttlSeconds: 300 });
    expect(() => settleRun(account, authorization.run.id, { inputTokens: 0, outputTokens: 200_000 }, model))
      .toThrowError(CommerceDomainError);
    expect(account.runs[0]).toMatchObject({ status: "failed", chargedPoints: 50 });
    expect(calculateBalance(account)).toMatchObject({ availablePoints: 50, grantedPoints: 50 });
  });

  it("charges the entire remaining reservation when upstream omits usage", () => {
    expect(calculateGatewayRequestCharge(39, undefined, model)).toBe(39);
  });
});
