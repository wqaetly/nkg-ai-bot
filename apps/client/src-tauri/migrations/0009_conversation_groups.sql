CREATE TABLE IF NOT EXISTS conversation_groups (
  id TEXT PRIMARY KEY NOT NULL,
  assistant_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (assistant_id, name)
);

ALTER TABLE conversations ADD COLUMN group_id TEXT
  REFERENCES conversation_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_groups_assistant
  ON conversation_groups(assistant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_group_updated
  ON conversations(group_id, updated_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_conversation_group_skill_insert
BEFORE INSERT ON conversations
WHEN NEW.group_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM conversation_groups
   WHERE id=NEW.group_id AND assistant_id=NEW.assistant_id
)
BEGIN
  SELECT RAISE(ABORT, 'conversation group must belong to the same assistant skill');
END;

CREATE TRIGGER IF NOT EXISTS trg_conversation_group_skill_update
BEFORE UPDATE OF assistant_id, group_id ON conversations
WHEN NEW.group_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM conversation_groups
   WHERE id=NEW.group_id AND assistant_id=NEW.assistant_id
)
BEGIN
  SELECT RAISE(ABORT, 'conversation group must belong to the same assistant skill');
END;
