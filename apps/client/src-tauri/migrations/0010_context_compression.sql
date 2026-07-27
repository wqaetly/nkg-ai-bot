ALTER TABLE provider_profiles ADD COLUMN model_context_windows_json TEXT NOT NULL DEFAULT '{}'
  CHECK (
    json_valid(model_context_windows_json)
    AND json_type(model_context_windows_json) = 'object'
  );

CREATE TABLE IF NOT EXISTS conversation_compressions (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
  summary TEXT NOT NULL DEFAULT '',
  source_token_count INTEGER NOT NULL CHECK (source_token_count >= 0),
  summary_token_count INTEGER NOT NULL DEFAULT 0 CHECK (summary_token_count >= 0),
  model_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'stale')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_compressions_latest
  ON conversation_compressions(conversation_id, status, through_sequence DESC, updated_at DESC);
