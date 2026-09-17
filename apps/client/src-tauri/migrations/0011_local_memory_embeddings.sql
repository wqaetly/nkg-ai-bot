CREATE TABLE IF NOT EXISTS memory_item_embeddings (
  memory_id TEXT NOT NULL,
  model_key TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0 AND dimensions <= 8192),
  vector_base64 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, model_key),
  FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_item_embeddings_model
  ON memory_item_embeddings(model_key, updated_at DESC);
