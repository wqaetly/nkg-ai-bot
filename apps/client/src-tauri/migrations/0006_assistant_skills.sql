CREATE TABLE IF NOT EXISTS assistant_versions (
  assistant_id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  flow_version TEXT NOT NULL,
  memory_namespace TEXT NOT NULL DEFAULT 'global',
  capabilities_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(capabilities_json) AND json_type(capabilities_json) = 'array'),
  activation_hints_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(activation_hints_json) AND json_type(activation_hints_json) = 'array'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (assistant_id, version),
  FOREIGN KEY (assistant_id) REFERENCES assistants(id) ON DELETE CASCADE,
  FOREIGN KEY (flow_id, flow_version) REFERENCES flows(id, version)
);

CREATE TRIGGER IF NOT EXISTS trg_assistant_versions_immutable
BEFORE UPDATE ON assistant_versions
BEGIN
  SELECT RAISE(ABORT, 'assistant versions are immutable');
END;

CREATE TABLE IF NOT EXISTS assistant_active (
  assistant_id TEXT PRIMARY KEY NOT NULL,
  active_version TEXT NOT NULL,
  previous_version TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (assistant_id, active_version)
    REFERENCES assistant_versions(assistant_id, version),
  FOREIGN KEY (assistant_id, previous_version)
    REFERENCES assistant_versions(assistant_id, version)
);

CREATE TABLE IF NOT EXISTS assistant_skill_usage (
  assistant_id TEXT NOT NULL,
  assistant_version TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_used_at INTEGER,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (success_count + failure_count <= use_count),
  PRIMARY KEY (assistant_id, assistant_version),
  FOREIGN KEY (assistant_id, assistant_version)
    REFERENCES assistant_versions(assistant_id, version) ON DELETE CASCADE
);

ALTER TABLE conversations ADD COLUMN assistant_version TEXT;

CREATE TRIGGER IF NOT EXISTS trg_conversation_assistant_version_insert
BEFORE INSERT ON conversations
WHEN NEW.assistant_version IS NOT NULL AND (
  NEW.assistant_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM assistant_versions
     WHERE assistant_id=NEW.assistant_id AND version=NEW.assistant_version
  )
)
BEGIN
  SELECT RAISE(ABORT, 'conversation assistant version does not exist');
END;

CREATE TRIGGER IF NOT EXISTS trg_conversation_assistant_version_update
BEFORE UPDATE OF assistant_id, assistant_version ON conversations
WHEN NEW.assistant_version IS NOT NULL AND (
  NEW.assistant_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM assistant_versions
     WHERE assistant_id=NEW.assistant_id AND version=NEW.assistant_version
  )
)
BEGIN
  SELECT RAISE(ABORT, 'conversation assistant version does not exist');
END;

CREATE TABLE IF NOT EXISTS assistant_run_links (
  id TEXT PRIMARY KEY NOT NULL,
  runtime_run_id TEXT UNIQUE,
  conversation_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT,
  assistant_id TEXT NOT NULL,
  assistant_version TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  flow_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (assistant_message_id) REFERENCES messages(id) ON DELETE SET NULL,
  FOREIGN KEY (assistant_id, assistant_version)
    REFERENCES assistant_versions(assistant_id, version)
);

CREATE TRIGGER IF NOT EXISTS trg_assistant_run_link_flow_match
BEFORE INSERT ON assistant_run_links
WHEN NOT EXISTS (
  SELECT 1 FROM assistant_versions
   WHERE assistant_id=NEW.assistant_id
     AND version=NEW.assistant_version
     AND flow_id=NEW.flow_id
     AND flow_version=NEW.flow_version
)
BEGIN
  SELECT RAISE(ABORT, 'assistant run flow does not match its immutable version');
END;

CREATE INDEX IF NOT EXISTS idx_assistant_active_discovery
  ON assistant_active(archived_at, pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_run_links_skill
  ON assistant_run_links(assistant_id, assistant_version, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_assistant_version
  ON conversations(assistant_id, assistant_version);
