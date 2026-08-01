export type PointBucket = "purchased" | "granted";
export type LedgerKind = "purchase" | "grant" | "usage" | "refund" | "adjustment";

export interface LedgerEntry {
  id: string;
  accountId: string;
  bucket: PointBucket;
  kind: LedgerKind;
  pointsDelta: number;
  referenceType: "apple_transaction" | "model_run" | "gateway_request" | "admin" | "promotion";
  referenceId: string;
  createdAt: string;
}

export interface PointBalance {
  availablePoints: number;
  purchasedPoints: number;
  grantedPoints: number;
  reservedPoints: number;
  debtPoints: number;
  updatedAt: string;
}

export interface ModelRate {
  id: string;
  name: string;
  contextWindow: number;
  inputPointsPerMillionTokens: number;
  outputPointsPerMillionTokens: number;
  reservePoints: number;
  capabilities: string[];
}

export interface PointPack {
  id: string;
  points: number;
  appleProductId: string;
  featured: boolean;
}

export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  appAccountToken: string;
  productId: string;
  environment: "Production" | "Sandbox";
  purchaseDate: string;
  revokedAt?: string;
}

export type ModelRunStatus = "authorized" | "in_progress" | "settled" | "released" | "failed";

export interface ModelRun {
  id: string;
  accountId: string;
  requestId: string;
  flowId: string;
  modelId: string;
  reservedPoints: number;
  status: ModelRunStatus;
  expiresAt: string;
  inputTokens?: number;
  outputTokens?: number;
  chargedPoints?: number;
}

export interface AccountPointState {
  accountId: string;
  appAccountToken: string;
  ledger: LedgerEntry[];
  runs: ModelRun[];
  appleTransactions: AppleTransaction[];
}

export interface PurchaseCreditResult {
  credited: boolean;
  creditedPoints: number;
  transactionId: string;
  balance: PointBalance;
}

export interface RunAuthorizationResult {
  run: ModelRun;
  balance: PointBalance;
  replayed: boolean;
}

export interface RunSettlementResult {
  run: ModelRun;
  balance: PointBalance;
}

export class CommerceDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "CommerceDomainError";
  }
}

export function calculateBalance(state: AccountPointState, now = new Date()): PointBalance {
  const purchasedRaw = sumBucket(state.ledger, "purchased");
  const grantedRaw = sumBucket(state.ledger, "granted");
  const reservedPoints = state.runs
    .filter((run) => (run.status === "authorized" || run.status === "in_progress") && Date.parse(run.expiresAt) > now.getTime())
    .reduce((total, run) => total + remainingRunReservation(run), 0);
  const totalRaw = purchasedRaw + grantedRaw;
  const debtPoints = Math.max(0, -totalRaw);
  return {
    availablePoints: Math.max(0, totalRaw - reservedPoints),
    purchasedPoints: Math.max(0, purchasedRaw),
    grantedPoints: Math.max(0, grantedRaw),
    reservedPoints,
    debtPoints,
    updatedAt: latestTimestamp(state, now.toISOString()),
  };
}

export function creditApplePurchase(
  state: AccountPointState,
  transaction: AppleTransaction,
  pack: PointPack,
  now = new Date(),
): PurchaseCreditResult {
  requireAccountToken(state, transaction.appAccountToken);
  if (transaction.productId !== pack.appleProductId) {
    throw new CommerceDomainError("unknown_product", "App Store 商品不属于当前点数目录", 400);
  }
  if (transaction.revokedAt) {
    throw new CommerceDomainError("revoked_transaction", "App Store 交易已退款或撤销", 409);
  }
  const existing = state.appleTransactions.find(
    (candidate) => candidate.transactionId === transaction.transactionId,
  );
  if (existing) {
    if (existing.appAccountToken !== transaction.appAccountToken) {
      throw new CommerceDomainError("transaction_account_conflict", "交易已绑定其他账户", 409);
    }
    return {
      credited: false,
      creditedPoints: pack.points,
      transactionId: transaction.transactionId,
      balance: calculateBalance(state, now),
    };
  }
  state.appleTransactions.push({ ...transaction });
  state.ledger.push({
    id: crypto.randomUUID(),
    accountId: state.accountId,
    bucket: "purchased",
    kind: "purchase",
    pointsDelta: pack.points,
    referenceType: "apple_transaction",
    referenceId: transaction.transactionId,
    createdAt: now.toISOString(),
  });
  return {
    credited: true,
    creditedPoints: pack.points,
    transactionId: transaction.transactionId,
    balance: calculateBalance(state, now),
  };
}

export function authorizeRun(
  state: AccountPointState,
  input: { requestId: string; flowId: string; model: ModelRate; ttlSeconds: number },
  now = new Date(),
): RunAuthorizationResult {
  releaseExpiredRuns(state, now);
  const existing = state.runs.find((run) => run.requestId === input.requestId);
  if (existing) {
    if (existing.modelId !== input.model.id || existing.flowId !== input.flowId) {
      throw new CommerceDomainError("idempotency_conflict", "运行幂等键对应了不同请求", 409);
    }
    if (!(existing.status === "authorized" || existing.status === "in_progress")
      || remainingRunReservation(existing) <= 0
      || Date.parse(existing.expiresAt) <= now.getTime()) {
      throw new CommerceDomainError("authorization_expired", "运行授权已失效", 409);
    }
    return { run: { ...existing }, balance: calculateBalance(state, now), replayed: true };
  }
  const balance = calculateBalance(state, now);
  if (balance.debtPoints > 0 || balance.availablePoints < input.model.reservePoints) {
    throw new CommerceDomainError("insufficient_points", "AI 点数不足，请充值后重试", 402);
  }
  const run: ModelRun = {
    id: crypto.randomUUID(),
    accountId: state.accountId,
    requestId: input.requestId,
    flowId: input.flowId,
    modelId: input.model.id,
    reservedPoints: input.model.reservePoints,
    status: "authorized",
    expiresAt: new Date(now.getTime() + input.ttlSeconds * 1_000).toISOString(),
  };
  state.runs.push(run);
  return { run: { ...run }, balance: calculateBalance(state, now), replayed: false };
}

export function settleRun(
  state: AccountPointState,
  runId: string,
  usage: { inputTokens: number; outputTokens: number },
  model: ModelRate,
  now = new Date(),
): RunSettlementResult {
  const run = state.runs.find((candidate) => candidate.id === runId);
  if (!run) throw new CommerceDomainError("run_not_found", "运行授权不存在", 404);
  if (run.modelId !== model.id) throw new CommerceDomainError("model_mismatch", "运行模型不匹配", 409);
  if (run.status === "settled") return { run: { ...run }, balance: calculateBalance(state, now) };
  if (!(run.status === "authorized" || run.status === "in_progress")) {
    throw new CommerceDomainError("run_not_authorized", "运行授权不能结算", 409);
  }
  const requestedCharge = calculateUsagePoints(usage, model);
  const remainingReservation = remainingRunReservation(run);
  const exceededReservation = requestedCharge > remainingReservation;
  const chargedPoints = Math.min(requestedCharge, remainingReservation);
  const buckets = spendPlan(state, chargedPoints);
  const gatewayRequestId = crypto.randomUUID();
  for (const [bucket, points] of buckets) {
    if (!points) continue;
    state.ledger.push({
      id: crypto.randomUUID(),
      accountId: state.accountId,
      bucket,
      kind: "usage",
      pointsDelta: -points,
      referenceType: "gateway_request",
      referenceId: gatewayRequestId,
      createdAt: now.toISOString(),
    });
  }
  const cumulativeCharge = (run.chargedPoints ?? 0) + chargedPoints;
  Object.assign(run, {
    status: exceededReservation
      ? "failed" satisfies ModelRunStatus
      : cumulativeCharge >= run.reservedPoints
      ? "settled" satisfies ModelRunStatus
      : "in_progress" satisfies ModelRunStatus,
    inputTokens: (run.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (run.outputTokens ?? 0) + usage.outputTokens,
    chargedPoints: cumulativeCharge,
  });
  if (exceededReservation) {
    throw new CommerceDomainError("usage_exceeds_reservation", "模型用量超过运行预留", 409);
  }
  return { run: { ...run }, balance: calculateBalance(state, now) };
}

export function releaseExpiredRuns(state: AccountPointState, now = new Date()): number {
  let released = 0;
  for (const run of state.runs) {
    if ((run.status === "authorized" || run.status === "in_progress")
      && Date.parse(run.expiresAt) <= now.getTime()) {
      run.status = "released";
      released += 1;
    }
  }
  return released;
}

export function remainingRunReservation(
  run: Pick<ModelRun, "reservedPoints" | "chargedPoints">,
): number {
  return Math.max(0, run.reservedPoints - (run.chargedPoints ?? 0));
}

export function calculateGatewayRequestCharge(
  remainingReservation: number,
  usage: { inputTokens: number; outputTokens: number } | undefined,
  model: Pick<ModelRate, "inputPointsPerMillionTokens" | "outputPointsPerMillionTokens">,
): number {
  if (!Number.isSafeInteger(remainingReservation) || remainingReservation < 0) {
    throw new CommerceDomainError("invalid_reservation", "运行预留点数无效", 500);
  }
  return usage ? calculateUsagePoints(usage, model) : remainingReservation;
}

export function calculateUsagePoints(
  usage: { inputTokens: number; outputTokens: number },
  model: Pick<ModelRate, "inputPointsPerMillionTokens" | "outputPointsPerMillionTokens">,
): number {
  if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
    || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) {
    throw new CommerceDomainError("invalid_usage", "模型 token 用量无效", 400);
  }
  const raw = usage.inputTokens * model.inputPointsPerMillionTokens
    + usage.outputTokens * model.outputPointsPerMillionTokens;
  return raw === 0 ? 0 : Math.max(1, Math.ceil(raw / 1_000_000));
}

function spendPlan(state: AccountPointState, points: number): Array<[PointBucket, number]> {
  const granted = Math.max(0, sumBucket(state.ledger, "granted"));
  const purchased = Math.max(0, sumBucket(state.ledger, "purchased"));
  if (points > granted + purchased) {
    throw new CommerceDomainError("insufficient_points", "AI 点数不足，请充值后重试", 402);
  }
  const grantedSpend = Math.min(granted, points);
  return [["granted", grantedSpend], ["purchased", points - grantedSpend]];
}

function sumBucket(entries: LedgerEntry[], bucket: PointBucket): number {
  return entries
    .filter((entry) => entry.bucket === bucket)
    .reduce((total, entry) => total + entry.pointsDelta, 0);
}

function requireAccountToken(state: AccountPointState, token: string): void {
  if (state.appAccountToken.toLowerCase() !== token.toLowerCase()) {
    throw new CommerceDomainError("account_token_mismatch", "App Store 交易不属于当前账户", 403);
  }
}

function latestTimestamp(state: AccountPointState, fallback: string): string {
  return state.ledger.reduce(
    (latest, entry) => Date.parse(entry.createdAt) > Date.parse(latest) ? entry.createdAt : latest,
    fallback,
  );
}
