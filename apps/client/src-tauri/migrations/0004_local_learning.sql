CREATE TABLE IF NOT EXISTS message_feedback (
  id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('positive', 'negative')),
  correction TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS learning_candidates (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('memory_fact')),
  namespace TEXT NOT NULL DEFAULT 'global',
  source_message_id TEXT,
  source_conversation_id TEXT,
  proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
  rationale TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  target_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL,
  FOREIGN KEY (source_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'global',
  content TEXT NOT NULL,
  content_key TEXT NOT NULL,
  source_message_id TEXT,
  confidence REAL NOT NULL DEFAULT 1
    CHECK (confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL,
  UNIQUE (namespace, content_key)
);

CREATE INDEX IF NOT EXISTS idx_message_feedback_conversation
  ON message_feedback(conversation_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_candidates_status
  ON learning_candidates(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_items_namespace_status
  ON memory_items(namespace, status, updated_at DESC);
