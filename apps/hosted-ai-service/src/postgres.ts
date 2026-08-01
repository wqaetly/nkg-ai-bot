import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import {
  CommerceDomainError,
  calculateGatewayRequestCharge,
  remainingRunReservation,
  type AppleTransaction,
  type ModelRate,
  type PointBalance,
  type PointPack,
} from "./domain.js";
import { createRecoveryToken, createRunToken, createSessionToken, hashToken } from "./tokens.js";

export interface AccountIdentity {
  accountId: string;
  appAccountToken: string;
}

export interface AnonymousSessionResult extends AccountIdentity {
  sessionToken: string;
  sessionExpiresAt: string;
  balance: PointBalance;
  recoveryToken?: string;
}

export interface AuthorizedRunRecord {
  id: string;
  accountId: string;
  requestId: string;
  flowId: string;
  modelId: string;
  reservedPoints: number;
  chargedPoints: number;
  status: "authorized" | "in_progress" | "settled" | "released" | "failed";
  expiresAt: string;
}

export interface GatewayRequestClaim {
  run: AuthorizedRunRecord;
  gatewayRequestId: string;
}

export interface RunAuthorizationRecord {
  run: AuthorizedRunRecord;
  apiKey: string;
  balance: PointBalance;
}

export class PostgresCommerceRepository {
  readonly pool: Pool;

  constructor(
    databaseUrl: string,
    private readonly runTokenSecret: string,
    private readonly sessionDays: number,
    private readonly welcomeGrantPoints: number,
  ) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 12 });
  }

  close(): Promise<void> {
    return this.pool.end();
  }

  async checkHealth(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async migrate(): Promise<void> {
    const migrationDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const files = ["0001_commerce.sql"];
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const file of files) {
      const sql = await readFile(join(migrationDir, file), "utf8");
      await withTransaction(this.pool, async (client) => {
        const applied = await client.query<{ version: string }>(
          "SELECT version FROM schema_migrations WHERE version = $1",
          [basename(file, ".sql")],
        );
        if (applied.rows.length) return;
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING", [basename(file, ".sql")]);
      });
    }
  }

  async startAnonymousSession(input: {
    installationId: string;
    platform: string;
    appVersion: string;
  }): Promise<AnonymousSessionResult> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.installationId]);
      const existing = await client.query<{ account_id: string; app_account_token: string }>(`
        SELECT i.account_id, a.app_account_token::text
        FROM installations i JOIN accounts a ON a.id = i.account_id
        WHERE i.installation_id = $1 AND a.status = 'active'
      `, [input.installationId]);
      let accountId: string;
      let appAccountToken: string;
      let recoveryToken: string | undefined;
      if (existing.rows[0]) {
        accountId = existing.rows[0].account_id;
        appAccountToken = existing.rows[0].app_account_token;
        await client.query(`
          UPDATE installations SET platform = $2, last_app_version = $3, updated_at = now()
          WHERE installation_id = $1
        `, [input.installationId, input.platform, input.appVersion]);
      } else {
        accountId = randomUUID();
        appAccountToken = randomUUID();
        recoveryToken = createRecoveryToken();
        await client.query(
          "INSERT INTO accounts(id, app_account_token, recovery_token_hash) VALUES ($1, $2, $3)",
          [accountId, appAccountToken, hashToken(recoveryToken)],
        );
        await client.query(`
          INSERT INTO installations(installation_id, account_id, platform, first_app_version, last_app_version)
          VALUES ($1, $2, $3, $4, $4)
        `, [input.installationId, accountId, input.platform, input.appVersion]);
        if (this.welcomeGrantPoints > 0) {
          await client.query(`
            INSERT INTO point_ledger(id, account_id, bucket, kind, points_delta, reference_type, reference_id)
            VALUES ($1, $2, 'granted', 'grant', $3, 'promotion', $4)
          `, [randomUUID(), accountId, this.welcomeGrantPoints, `welcome:${accountId}`]);
        }
      }
      const session = await createAccountSession(client, accountId, this.sessionDays);
      return {
        accountId,
        appAccountToken,
        sessionToken: session.token,
        sessionExpiresAt: session.expiresAt,
        balance: await getBalance(client, accountId),
        ...(recoveryToken ? { recoveryToken } : {}),
      };
    });
  }

  async recoverAnonymousSession(input: {
    recoveryToken: string;
    installationId: string;
    platform: string;
    appVersion: string;
  }): Promise<AnonymousSessionResult> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.installationId]);
      const result = await client.query<{ id: string; app_account_token: string }>(`
        SELECT id, app_account_token::text
        FROM accounts
        WHERE recovery_token_hash = $1 AND status = 'active'
        FOR UPDATE
      `, [hashToken(input.recoveryToken)]);
      const account = result.rows[0];
      if (!account) throw new CommerceDomainError("invalid_recovery_token", "账户恢复码无效", 401);
      await client.query(`
        INSERT INTO installations(
          installation_id, account_id, platform, first_app_version, last_app_version
        ) VALUES ($1,$2,$3,$4,$4)
        ON CONFLICT (installation_id) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          platform = EXCLUDED.platform,
          last_app_version = EXCLUDED.last_app_version,
          updated_at = now()
      `, [input.installationId, account.id, input.platform, input.appVersion]);
      const session = await createAccountSession(client, account.id, this.sessionDays);
      return {
        accountId: account.id,
        appAccountToken: account.app_account_token,
        sessionToken: session.token,
        sessionExpiresAt: session.expiresAt,
        balance: await getBalance(client, account.id),
      };
    });
  }

  async rotateRecoveryToken(accountId: string): Promise<string> {
    const recoveryToken = createRecoveryToken();
    const result = await this.pool.query(`
      UPDATE accounts SET recovery_token_hash = $2, updated_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING id
    `, [accountId, hashToken(recoveryToken)]);
    if (!result.rows.length) throw new CommerceDomainError("account_unavailable", "NKG AI 账户不可用", 403);
    return recoveryToken;
  }

  async authenticateSession(token: string): Promise<AccountIdentity> {
    const result = await this.pool.query<{ account_id: string; app_account_token: string }>(`
      UPDATE account_sessions s SET last_seen_at = now()
      FROM accounts a
      WHERE s.token_hash = $1 AND s.expires_at > now() AND a.id = s.account_id AND a.status = 'active'
      RETURNING s.account_id, a.app_account_token::text
    `, [hashToken(token)]);
    const row = result.rows[0];
    if (!row) throw new CommerceDomainError("invalid_session", "NKG AI 登录状态已失效，请重新连接", 401);
    return { accountId: row.account_id, appAccountToken: row.app_account_token };
  }

  async getBalance(accountId: string): Promise<PointBalance> {
    return withTransaction(this.pool, async (client) => {
      await lockActiveAccount(client, accountId);
      await reconcileExpiredRuns(client, accountId);
      return getBalance(client, accountId);
    });
  }

  async creditApplePurchase(input: {
    account: AccountIdentity;
    transaction: AppleTransaction;
    pointPack: PointPack;
    signedTransactionInfo: string;
  }): Promise<{ transactionId: string; creditedPoints: number; balance: PointBalance }> {
    return withTransaction(this.pool, async (client) => {
      await lockActiveAccount(client, input.account.accountId);
      if (input.account.appAccountToken.toLowerCase() !== input.transaction.appAccountToken.toLowerCase()) {
        throw new CommerceDomainError("account_token_mismatch", "App Store 交易不属于当前账户", 403);
      }
      if (input.transaction.productId !== input.pointPack.appleProductId) {
        throw new CommerceDomainError("unknown_product", "App Store 商品不属于当前点数目录", 400);
      }
      if (input.transaction.revokedAt) {
        throw new CommerceDomainError("revoked_transaction", "App Store 交易已退款或撤销", 409);
      }
      const tombstone = await client.query(
        "SELECT transaction_id FROM apple_transaction_tombstones WHERE transaction_id = $1",
        [input.transaction.transactionId],
      );
      if (tombstone.rows.length) {
        throw new CommerceDomainError("revoked_transaction", "App Store 交易已退款或撤销", 409);
      }
      const inserted = await client.query<{ transaction_id: string }>(`
        INSERT INTO apple_transactions(
          transaction_id, original_transaction_id, account_id, app_account_token,
          product_id, environment, purchase_date, revoked_at, signed_transaction_hash
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (transaction_id) DO NOTHING
        RETURNING transaction_id
      `, [
        input.transaction.transactionId,
        input.transaction.originalTransactionId,
        input.account.accountId,
        input.transaction.appAccountToken,
        input.transaction.productId,
        input.transaction.environment,
        input.transaction.purchaseDate,
        input.transaction.revokedAt ?? null,
        createHash("sha256").update(input.signedTransactionInfo).digest(),
      ]);
      if (!inserted.rows.length) {
        const existing = await client.query<{ account_id: string; product_id: string }>(
          "SELECT account_id, product_id FROM apple_transactions WHERE transaction_id = $1",
          [input.transaction.transactionId],
        );
        if (existing.rows[0]?.account_id !== input.account.accountId
          || existing.rows[0]?.product_id !== input.transaction.productId) {
          throw new CommerceDomainError("transaction_conflict", "App Store 交易已绑定其他账户或商品", 409);
        }
      } else {
        await client.query(`
          INSERT INTO point_ledger(id, account_id, bucket, kind, points_delta, reference_type, reference_id)
          VALUES ($1, $2, 'purchased', 'purchase', $3, 'apple_transaction', $4)
        `, [randomUUID(), input.account.accountId, input.pointPack.points, input.transaction.transactionId]);
      }
      return {
        transactionId: input.transaction.transactionId,
        creditedPoints: input.pointPack.points,
        balance: await getBalance(client, input.account.accountId),
      };
    });
  }

  async applyAppleRevocation(input: {
    transaction: AppleTransaction;
    pointPack: PointPack;
    signedPayload: string;
  }): Promise<void> {
    if (input.transaction.productId !== input.pointPack.appleProductId) return;
    const revokedAt = input.transaction.revokedAt ?? new Date().toISOString();
    await withTransaction(this.pool, async (client) => {
      await client.query(`
        INSERT INTO apple_transaction_tombstones(
          transaction_id, app_account_token, product_id, revoked_at, signed_notification_hash
        ) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (transaction_id) DO UPDATE SET
          revoked_at = LEAST(apple_transaction_tombstones.revoked_at, EXCLUDED.revoked_at)
      `, [
        input.transaction.transactionId,
        input.transaction.appAccountToken,
        input.transaction.productId,
        revokedAt,
        createHash("sha256").update(input.signedPayload).digest(),
      ]);
      const account = await client.query<{ id: string }>(
        "SELECT id FROM accounts WHERE app_account_token = $1 FOR UPDATE",
        [input.transaction.appAccountToken],
      );
      const accountId = account.rows[0]?.id;
      if (!accountId) return;
      const transaction = await client.query<{ account_id: string }>(`
        UPDATE apple_transactions SET revoked_at = $2
        WHERE transaction_id = $1
        RETURNING account_id
      `, [input.transaction.transactionId, revokedAt]);
      if (!transaction.rows.length) return;
      if (transaction.rows[0]!.account_id !== accountId) {
        throw new CommerceDomainError("transaction_account_conflict", "退款交易账户冲突", 409);
      }
      await client.query(`
        INSERT INTO point_ledger(id, account_id, bucket, kind, points_delta, reference_type, reference_id)
        VALUES ($1,$2,'purchased','refund',$3,'apple_transaction',$4)
        ON CONFLICT (kind, reference_type, reference_id, bucket) DO NOTHING
      `, [randomUUID(), accountId, -input.pointPack.points, input.transaction.transactionId]);
    });
  }

  async authorizeRun(input: {
    accountId: string;
    requestId: string;
    flowId: string;
    model: ModelRate;
    ttlSeconds: number;
  }): Promise<RunAuthorizationRecord> {
    return withTransaction(this.pool, async (client) => {
      await lockActiveAccount(client, input.accountId);
      await reconcileExpiredRuns(client, input.accountId);
      const existing = await client.query<RunRow>(`
        SELECT id, account_id, request_id::text, flow_id, model_id, reserved_points::text,
          charged_points::text, status, expires_at
        FROM model_runs WHERE account_id = $1 AND request_id = $2
      `, [input.accountId, input.requestId]);
      let run: AuthorizedRunRecord;
      if (existing.rows[0]) {
        run = mapRun(existing.rows[0]);
        if (run.flowId !== input.flowId || run.modelId !== input.model.id) {
          throw new CommerceDomainError("idempotency_conflict", "运行幂等键对应了不同请求", 409);
        }
        if (!(run.status === "authorized" || run.status === "in_progress")
          || Date.parse(run.expiresAt) <= Date.now()
          || run.chargedPoints >= run.reservedPoints) {
          throw new CommerceDomainError("authorization_expired", "运行授权已失效", 409);
        }
      } else {
        const balance = await getBalance(client, input.accountId);
        if (balance.debtPoints > 0 || balance.availablePoints < input.model.reservePoints) {
          throw new CommerceDomainError("insufficient_points", "AI 点数不足，请充值后重试", 402);
        }
        const result = await client.query<RunRow>(`
          INSERT INTO model_runs(id, account_id, request_id, flow_id, model_id, reserved_points, status, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,'authorized', now() + ($7 * interval '1 second'))
          RETURNING id, account_id, request_id::text, flow_id, model_id, reserved_points::text,
            charged_points::text, status, expires_at
        `, [randomUUID(), input.accountId, input.requestId, input.flowId, input.model.id, input.model.reservePoints, input.ttlSeconds]);
        run = mapRun(result.rows[0]!);
      }
      return {
        run,
        apiKey: createRunToken(run.id, this.runTokenSecret),
        balance: await getBalance(client, input.accountId),
      };
    });
  }

  async completeRun(accountId: string, runId: string): Promise<PointBalance> {
    return withTransaction(this.pool, async (client) => {
      await lockActiveAccount(client, accountId);
      const result = await client.query<RunRow>(`
        SELECT id, account_id, request_id::text, flow_id, model_id, reserved_points::text,
          charged_points::text, status, expires_at
        FROM model_runs WHERE id = $1 AND account_id = $2 FOR UPDATE
      `, [runId, accountId]);
      const row = result.rows[0];
      if (!row) throw new CommerceDomainError("run_not_found", "运行授权不存在", 404);
      const run = mapRun(row);
      if (run.status === "authorized" || run.status === "in_progress") {
        await finalizeLockedRun(client, run);
      }
      return getBalance(client, accountId);
    });
  }

  async claimGatewayRequest(runId: string): Promise<GatewayRequestClaim> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<RunRow>(`
        SELECT id, account_id, request_id::text, flow_id, model_id, reserved_points::text,
          charged_points::text, status, expires_at
        FROM model_runs WHERE id = $1 FOR UPDATE
      `, [runId]);
      const row = result.rows[0];
      if (!row) throw new CommerceDomainError("invalid_run_token", "运行授权不存在", 401);
      const run = mapRun(row);
      if (!(run.status === "authorized" || run.status === "in_progress")
        || Date.parse(run.expiresAt) <= Date.now()
        || run.chargedPoints >= run.reservedPoints) {
        throw new CommerceDomainError("invalid_run_token", "运行授权已失效或点数已用完", 401);
      }
      const count = await client.query<{ count: string; active: string }>(`
        SELECT COUNT(*)::text AS count,
          COUNT(*) FILTER (WHERE status = 'in_progress')::text AS active
        FROM gateway_requests WHERE run_id = $1
      `,
        [runId],
      );
      if (safeInteger(count.rows[0]?.count ?? "0", "gateway_request_count") >= 64) {
        throw new CommerceDomainError("run_request_limit", "工作流模型调用次数超过上限", 429);
      }
      if (safeInteger(count.rows[0]?.active ?? "0", "active_gateway_request_count") >= 4) {
        throw new CommerceDomainError("run_concurrency_limit", "工作流并发模型调用过多，请稍后重试", 429);
      }
      await client.query("UPDATE model_runs SET status = 'in_progress' WHERE id = $1", [runId]);
      const gatewayRequestId = randomUUID();
      await client.query(
        "INSERT INTO gateway_requests(id, run_id, status) VALUES ($1, $2, 'in_progress')",
        [gatewayRequestId, runId],
      );
      return { run: { ...run, status: "in_progress" }, gatewayRequestId };
    });
  }

  async ensureRunReservation(runId: string, targetPoints: number): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const identity = await client.query<{ account_id: string }>(
        "SELECT account_id FROM model_runs WHERE id = $1",
        [runId],
      );
      const accountId = identity.rows[0]?.account_id;
      if (!accountId) throw new CommerceDomainError("run_not_found", "运行授权不存在", 404);
      await lockActiveAccount(client, accountId);
      const result = await client.query<RunRow>(`
        SELECT id, account_id, request_id::text, flow_id, model_id, reserved_points::text,
          charged_points::text, status, expires_at
        FROM model_runs WHERE id = $1 FOR UPDATE
      `, [runId]);
      const run = mapRun(result.rows[0]!);
      if (run.status !== "in_progress" || Date.parse(run.expiresAt) <= Date.now()) {
        throw new CommerceDomainError("invalid_run_token", "运行授权已失效", 401);
      }
      const increase = Math.max(0, targetPoints - run.reservedPoints);
      if (!increase) return;
      const balance = await getBalance(client, accountId);
      if (balance.debtPoints > 0 || balance.availablePoints < increase) {
        throw new CommerceDomainError("insufficient_points", "AI 点数不足，无法使用这个模型", 402);
      }
      await client.query("UPDATE model_runs SET reserved_points = $2 WHERE id = $1", [runId, targetPoints]);
    });
  }

  async settleGatewayRequest(
    gatewayRequestId: string,
    model: ModelRate,
    usage?: { inputTokens: number; outputTokens: number },
  ): Promise<{ chargedPoints: number; balance: PointBalance }> {
    const outcome = await withTransaction(this.pool, async (client) => {
      const identity = await client.query<{ run_id: string; account_id: string }>(`
        SELECT g.run_id, r.account_id
        FROM gateway_requests g JOIN model_runs r ON r.id = g.run_id
        WHERE g.id = $1
      `, [gatewayRequestId]);
      const requestIdentity = identity.rows[0];
      if (!requestIdentity) throw new CommerceDomainError("gateway_request_not_found", "模型请求不存在", 404);
      await lockActiveAccount(client, requestIdentity.account_id);
      const result = await client.query<RunRow>(`
        SELECT id, account_id, request_id::text, flow_id, model_id, reserved_points::text,
          charged_points::text, status, expires_at
        FROM model_runs WHERE id = $1 FOR UPDATE
      `, [requestIdentity.run_id]);
      const row = result.rows[0];
      if (!row) throw new CommerceDomainError("run_not_found", "运行授权不存在", 404);
      const run = mapRun(row);
      const requestResult = await client.query<GatewayRequestRow>(`
        SELECT id, run_id, model_id, status, input_tokens::text, output_tokens::text, charged_points::text
        FROM gateway_requests WHERE id = $1 FOR UPDATE
      `, [gatewayRequestId]);
      const gatewayRequest = requestResult.rows[0];
      if (!gatewayRequest || gatewayRequest.run_id !== run.id) {
        throw new CommerceDomainError("gateway_request_not_found", "模型请求不存在", 404);
      }
      if (gatewayRequest.model_id !== model.id) {
        throw new CommerceDomainError("model_mismatch", "模型请求绑定不匹配", 409);
      }
      if (gatewayRequest.status === "settled") {
        return {
          chargedPoints: safeInteger(gatewayRequest.charged_points ?? "0", "charged_points"),
          balance: await getBalance(client, run.accountId),
        };
      }
      if (gatewayRequest.status !== "in_progress" || run.status !== "in_progress") {
        throw new CommerceDomainError("run_not_authorized", "模型请求不能结算", 409);
      }
      const remainingReservation = remainingRunReservation(run);
      const requestedCharge = calculateGatewayRequestCharge(remainingReservation, usage, model);
      const exceededReservation = requestedCharge > remainingReservation;
      const chargedPoints = Math.min(requestedCharge, remainingReservation);
      const raw = await getRawBuckets(client, run.accountId);
      if (chargedPoints > raw.purchased + raw.granted) {
        await client.query(
          "UPDATE gateway_requests SET status = 'failed', settled_at = now() WHERE id = $1",
          [gatewayRequestId],
        );
        await client.query("UPDATE model_runs SET status = 'failed', settled_at = now() WHERE id = $1", [run.id]);
        await failOtherGatewayRequests(client, run.id, gatewayRequestId);
        return { error: new CommerceDomainError("insufficient_points", "AI 点数不足，请充值后重试", 402) };
      }
      const grantedSpend = Math.min(raw.granted, chargedPoints);
      const purchasedSpend = chargedPoints - grantedSpend;
      if (grantedSpend) await insertUsage(client, run.accountId, gatewayRequestId, "granted", grantedSpend);
      if (purchasedSpend) await insertUsage(client, run.accountId, gatewayRequestId, "purchased", purchasedSpend);
      await client.query(`
        UPDATE gateway_requests SET status = 'settled', input_tokens = $2, output_tokens = $3,
          charged_points = $4, settled_at = now() WHERE id = $1
      `, [gatewayRequestId, usage?.inputTokens ?? null, usage?.outputTokens ?? null, chargedPoints]);
      const cumulativeCharge = run.chargedPoints + chargedPoints;
      await client.query(`
        UPDATE model_runs SET
          status = CASE
            WHEN $5 THEN 'failed'
            WHEN $4 >= reserved_points THEN 'settled'
            ELSE 'in_progress'
          END,
          input_tokens = input_tokens + $2,
          output_tokens = output_tokens + $3,
          charged_points = $4,
          settled_at = CASE WHEN $5 OR $4 >= reserved_points THEN now() ELSE NULL END
        WHERE id = $1
      `, [run.id, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, cumulativeCharge, exceededReservation]);
      if (exceededReservation || cumulativeCharge >= run.reservedPoints) {
        await failOtherGatewayRequests(client, run.id, gatewayRequestId);
      }
      if (exceededReservation) {
        return { error: new CommerceDomainError("usage_exceeds_reservation", "模型用量超过运行预留", 409) };
      }
      return { chargedPoints, balance: await getBalance(client, run.accountId) };
    });
    if ("error" in outcome) throw outcome.error;
    return outcome;
  }

  async markGatewayRequestAccepted(gatewayRequestId: string): Promise<void> {
    const result = await this.pool.query(`
      UPDATE gateway_requests SET upstream_accepted_at = COALESCE(upstream_accepted_at, now())
      WHERE id = $1 AND status = 'in_progress'
      RETURNING id
    `, [gatewayRequestId]);
    if (!result.rows.length) {
      throw new CommerceDomainError("gateway_request_not_active", "模型请求已失效", 409);
    }
  }

  async bindGatewayRequestModel(gatewayRequestId: string, modelId: string): Promise<void> {
    const result = await this.pool.query(`
      UPDATE gateway_requests SET model_id = $2
      WHERE id = $1 AND status = 'in_progress' AND (model_id IS NULL OR model_id = $2)
      RETURNING id
    `, [gatewayRequestId, modelId]);
    if (!result.rows.length) {
      throw new CommerceDomainError("gateway_request_not_active", "模型请求已失效", 409);
    }
  }

  async failGatewayRequest(gatewayRequestId: string): Promise<void> {
    await this.pool.query(`
      UPDATE gateway_requests SET status = 'failed', settled_at = now()
      WHERE id = $1 AND status = 'in_progress'
    `, [gatewayRequestId]);
  }
}

interface RunRow {
  id: string;
  account_id: string;
  request_id: string;
  flow_id: string;
  model_id: string;
  reserved_points: string;
  charged_points: string;
  status: AuthorizedRunRecord["status"];
  expires_at: Date | string;
}

function mapRun(row: RunRow): AuthorizedRunRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    requestId: row.request_id,
    flowId: row.flow_id,
    modelId: row.model_id,
    reservedPoints: safeInteger(row.reserved_points, "reserved_points"),
    chargedPoints: safeInteger(row.charged_points, "charged_points"),
    status: row.status,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

async function createAccountSession(
  client: PoolClient,
  accountId: string,
  sessionDays: number,
): Promise<{ token: string; expiresAt: string }> {
  await client.query(
    "DELETE FROM account_sessions WHERE account_id = $1 AND expires_at <= now()",
    [accountId],
  );
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + sessionDays * 86_400_000);
  await client.query(`
    INSERT INTO account_sessions(token_hash, account_id, expires_at)
    VALUES ($1, $2, $3)
  `, [hashToken(token), accountId, expiresAt]);
  return { token, expiresAt: expiresAt.toISOString() };
}

async function lockActiveAccount(client: PoolClient, accountId: string): Promise<void> {
  const result = await client.query("SELECT id FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE", [accountId]);
  if (!result.rows.length) throw new CommerceDomainError("account_unavailable", "NKG AI 账户不可用", 403);
}

async function getBalance(client: Pick<PoolClient, "query">, accountId: string): Promise<PointBalance> {
  const result = await client.query<{
    purchased: string; granted: string; reserved: string; updated_at: Date | string;
  }>(`
    WITH totals AS (
      SELECT
        COALESCE(SUM(points_delta) FILTER (WHERE bucket = 'purchased'), 0)::text AS purchased,
        COALESCE(SUM(points_delta) FILTER (WHERE bucket = 'granted'), 0)::text AS granted,
        COALESCE(MAX(created_at), now()) AS updated_at
      FROM point_ledger WHERE account_id = $1
    ), reservations AS (
      SELECT COALESCE(SUM(GREATEST(reserved_points - charged_points, 0)), 0)::text AS reserved
      FROM model_runs WHERE account_id = $1 AND status IN ('authorized', 'in_progress') AND expires_at > now()
    )
    SELECT totals.purchased, totals.granted, totals.updated_at, reservations.reserved
    FROM totals CROSS JOIN reservations
  `, [accountId]);
  const row = result.rows[0]!;
  const purchasedRaw = safeInteger(row.purchased, "purchased");
  const grantedRaw = safeInteger(row.granted, "granted");
  const reservedPoints = safeInteger(row.reserved, "reserved");
  const total = purchasedRaw + grantedRaw;
  return {
    availablePoints: Math.max(0, total - reservedPoints),
    purchasedPoints: Math.max(0, purchasedRaw),
    grantedPoints: Math.max(0, grantedRaw),
    reservedPoints,
    debtPoints: Math.max(0, -total),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function getRawBuckets(client: PoolClient, accountId: string): Promise<{ purchased: number; granted: number }> {
  const result = await client.query<{ purchased: string; granted: string }>(`
    SELECT
      COALESCE(SUM(points_delta) FILTER (WHERE bucket = 'purchased'), 0)::text AS purchased,
      COALESCE(SUM(points_delta) FILTER (WHERE bucket = 'granted'), 0)::text AS granted
    FROM point_ledger WHERE account_id = $1
  `, [accountId]);
  return {
    purchased: Math.max(0, safeInteger(result.rows[0]!.purchased, "purchased")),
    granted: Math.max(0, safeInteger(result.rows[0]!.granted, "granted")),
  };
}

async function insertUsage(
  client: PoolClient,
  accountId: string,
  gatewayRequestId: string,
  bucket: "purchased" | "granted",
  points: number,
): Promise<void> {
  await client.query(`
    INSERT INTO point_ledger(id, account_id, bucket, kind, points_delta, reference_type, reference_id)
    VALUES ($1,$2,$3,'usage',$4,'gateway_request',$5)
    ON CONFLICT (kind, reference_type, reference_id, bucket) DO NOTHING
  `, [randomUUID(), accountId, bucket, -points, gatewayRequestId]);
}

async function failOtherGatewayRequests(
  client: PoolClient,
  runId: string,
  exceptGatewayRequestId: string,
): Promise<void> {
  await client.query(`
    UPDATE gateway_requests SET status = 'failed', settled_at = now()
    WHERE run_id = $1 AND id <> $2 AND status = 'in_progress'
  `, [runId, exceptGatewayRequestId]);
}

interface GatewayRequestRow {
  id: string;
  run_id: string;
  model_id?: string | null;
  status: "in_progress" | "settled" | "failed";
  input_tokens: string | null;
  output_tokens: string | null;
  charged_points: string | null;
  upstream_accepted_at?: Date | string | null;
}

async function reconcileExpiredRuns(client: PoolClient, accountId: string): Promise<void> {
  const expired = await client.query<RunRow>(`
    SELECT id, account_id, request_id::text, flow_id, model_id, reserved_points::text,
      charged_points::text, status, expires_at
    FROM model_runs
    WHERE account_id = $1 AND status IN ('authorized', 'in_progress') AND expires_at <= now()
    ORDER BY expires_at, id
    FOR UPDATE
  `, [accountId]);
  for (const row of expired.rows) await finalizeLockedRun(client, mapRun(row));
}

async function finalizeLockedRun(client: PoolClient, run: AuthorizedRunRecord): Promise<void> {
  const accepted = await client.query<GatewayRequestRow>(`
      SELECT id, run_id, model_id, status, input_tokens::text, output_tokens::text,
        charged_points::text, upstream_accepted_at
      FROM gateway_requests
      WHERE run_id = $1 AND status = 'in_progress' AND upstream_accepted_at IS NOT NULL
      ORDER BY upstream_accepted_at, id
      FOR UPDATE
  `, [run.id]);
  const remaining = remainingRunReservation(run);
  if (accepted.rows[0] && remaining > 0) {
    const raw = await getRawBuckets(client, run.accountId);
    const grantedSpend = Math.min(raw.granted, remaining);
    if (grantedSpend) await insertUsage(client, run.accountId, accepted.rows[0].id, "granted", grantedSpend);
    const purchasedSpend = remaining - grantedSpend;
    if (purchasedSpend) await insertUsage(client, run.accountId, accepted.rows[0].id, "purchased", purchasedSpend);
    await client.query(`
        UPDATE gateway_requests SET status = 'settled', charged_points = $2, settled_at = now()
        WHERE id = $1
    `, [accepted.rows[0].id, remaining]);
    await client.query(`
        UPDATE model_runs SET status = 'settled', charged_points = reserved_points, settled_at = now()
        WHERE id = $1
    `, [run.id]);
  } else {
    await client.query("UPDATE model_runs SET status = 'released', settled_at = now() WHERE id = $1", [run.id]);
  }
  await client.query(`
      UPDATE gateway_requests SET status = 'failed', settled_at = now()
      WHERE run_id = $1 AND status = 'in_progress'
  `, [run.id]);
}

async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function safeInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} 超出安全整数范围`);
  return parsed;
}
