CREATE TABLE IF NOT EXISTS learning_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('reflection')),
  source_conversation_id TEXT NOT NULL,
  source_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  checkpoint_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(checkpoint_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  runtime_run_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (source_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

ALTER TABLE learning_candidates
  ADD COLUMN job_id TEXT REFERENCES learning_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_learning_jobs_status
  ON learning_jobs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_jobs_conversation
  ON learning_jobs(source_conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_candidates_job
  ON learning_candidates(job_id);
