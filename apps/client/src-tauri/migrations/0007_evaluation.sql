CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT PRIMARY KEY NOT NULL,
  assistant_id TEXT NOT NULL,
  assistant_version TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  assertions_json TEXT NOT NULL CHECK (
    json_valid(assertions_json) AND json_type(assertions_json) = 'object'
  ),
  source TEXT NOT NULL CHECK (source IN ('golden', 'user_correction', 'regression')),
  source_message_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (assistant_id, assistant_version)
    REFERENCES assistant_versions(assistant_id, version),
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS artifact_candidates (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assistant_prompt_patch', 'flow_patch')),
  assistant_id TEXT NOT NULL,
  base_version TEXT NOT NULL,
  proposed_version TEXT NOT NULL,
  proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
  rationale TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'evaluating', 'passed', 'failed', 'published', 'rejected')),
  latest_eval_run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  published_at INTEGER,
  FOREIGN KEY (assistant_id, base_version)
    REFERENCES assistant_versions(assistant_id, version)
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY NOT NULL,
  candidate_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'cancelled', 'interrupted')),
  baseline_score REAL CHECK (baseline_score IS NULL OR (baseline_score >= 0 AND baseline_score <= 1)),
  candidate_score REAL CHECK (candidate_score IS NULL OR (candidate_score >= 0 AND candidate_score <= 1)),
  gates_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(gates_json) AND json_type(gates_json) = 'array'
  ),
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(summary_json) AND json_type(summary_json) = 'object'
  ),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (candidate_id) REFERENCES artifact_candidates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS eval_case_results (
  eval_run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('baseline', 'candidate')),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'cancelled')),
  output_text TEXT NOT NULL DEFAULT '',
  score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  assertions_json TEXT NOT NULL CHECK (
    json_valid(assertions_json) AND json_type(assertions_json) = 'array'
  ),
  runtime_run_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (eval_run_id, case_id, variant),
  FOREIGN KEY (eval_run_id) REFERENCES eval_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (case_id) REFERENCES eval_cases(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS trg_artifact_candidate_published_requires_pass
BEFORE UPDATE OF status ON artifact_candidates
WHEN NEW.status = 'published' AND OLD.status <> 'passed'
BEGIN
  SELECT RAISE(ABORT, 'only a passed candidate can be published');
END;

CREATE INDEX IF NOT EXISTS idx_eval_cases_skill
  ON eval_cases(assistant_id, assistant_version, enabled, created_at);
CREATE INDEX IF NOT EXISTS idx_artifact_candidates_skill
  ON artifact_candidates(assistant_id, base_version, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_runs_candidate
  ON eval_runs(candidate_id, created_at DESC);
