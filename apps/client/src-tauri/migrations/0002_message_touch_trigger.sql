CREATE TRIGGER IF NOT EXISTS messages_touch_conversation_after_insert
AFTER INSERT ON messages
BEGIN
  UPDATE conversations
     SET updated_at = NEW.created_at
   WHERE id = NEW.conversation_id;
END;
