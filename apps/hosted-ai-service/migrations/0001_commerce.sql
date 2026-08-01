CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY,
  app_account_token uuid NOT NULL UNIQUE,
  recovery_token_hash bytea NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS installations (
  installation_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  platform text NOT NULL CHECK (platform IN ('windows', 'macos', 'linux', 'android', 'ios')),
  first_app_version text NOT NULL,
  last_app_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash bytea PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_sessions_account_idx ON account_sessions(account_id);
CREATE INDEX IF NOT EXISTS account_sessions_expiry_idx ON account_sessions(expires_at);

CREATE TABLE IF NOT EXISTS point_ledger (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  bucket text NOT NULL CHECK (bucket IN ('purchased', 'granted')),
  kind text NOT NULL CHECK (kind IN ('purchase', 'grant', 'usage', 'refund', 'adjustment')),
  points_delta bigint NOT NULL CHECK (points_delta <> 0),
  reference_type text NOT NULL CHECK (reference_type IN ('apple_transaction', 'model_run', 'gateway_request', 'admin', 'promotion')),
  reference_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, reference_type, reference_id, bucket)
);
CREATE INDEX IF NOT EXISTS point_ledger_account_idx ON point_ledger(account_id, created_at);

CREATE TABLE IF NOT EXISTS apple_transactions (
  transaction_id text PRIMARY KEY,
  original_transaction_id text NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  app_account_token uuid NOT NULL,
  product_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('Production', 'Sandbox')),
  purchase_date timestamptz NOT NULL,
  revoked_at timestamptz,
  signed_transaction_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apple_transactions_account_idx ON apple_transactions(account_id);

CREATE TABLE IF NOT EXISTS apple_transaction_tombstones (
  transaction_id text PRIMARY KEY,
  app_account_token uuid NOT NULL,
  product_id text NOT NULL,
  revoked_at timestamptz NOT NULL,
  signed_notification_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_runs (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  request_id uuid NOT NULL,
  flow_id text NOT NULL,
  model_id text NOT NULL,
  reserved_points bigint NOT NULL CHECK (reserved_points > 0),
  status text NOT NULL CHECK (status IN ('authorized', 'in_progress', 'settled', 'released', 'failed')),
  expires_at timestamptz NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  charged_points bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (account_id, request_id)
);
CREATE INDEX IF NOT EXISTS model_runs_authorized_idx ON model_runs(account_id, status, expires_at);

CREATE TABLE IF NOT EXISTS gateway_requests (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES model_runs(id),
  model_id text,
  status text NOT NULL CHECK (status IN ('in_progress', 'settled', 'failed')),
  input_tokens bigint,
  output_tokens bigint,
  charged_points bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  upstream_accepted_at timestamptz,
  settled_at timestamptz,
  CHECK (status <> 'settled' OR model_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS gateway_requests_run_idx ON gateway_requests(run_id, created_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
