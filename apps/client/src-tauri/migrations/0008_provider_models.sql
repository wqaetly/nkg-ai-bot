-- This release intentionally resets legacy password-vault Provider state.
DELETE FROM app_settings WHERE key = 'selected_provider_id';
DELETE FROM provider_profiles;

ALTER TABLE provider_profiles ADD COLUMN enabled_models_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(enabled_models_json) AND json_type(enabled_models_json) = 'array');

ALTER TABLE conversations ADD COLUMN provider_id TEXT;
ALTER TABLE conversations ADD COLUMN model_id TEXT;

CREATE TRIGGER IF NOT EXISTS trg_conversation_provider_model_insert
BEFORE INSERT ON conversations
WHEN NEW.model_id IS NOT NULL AND NEW.provider_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'conversation model requires a provider');
END;

CREATE TRIGGER IF NOT EXISTS trg_conversation_provider_model_update
BEFORE UPDATE OF provider_id, model_id ON conversations
WHEN NEW.model_id IS NOT NULL AND NEW.provider_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'conversation model requires a provider');
END;

CREATE INDEX IF NOT EXISTS idx_conversations_provider_model
  ON conversations(provider_id, model_id);
