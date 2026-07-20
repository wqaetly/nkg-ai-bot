PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runtime_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  flow_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS idx_runtime_runs_flow_created
  ON runtime_runs(flow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_flow_registry (
  flow_id TEXT NOT NULL,
  version TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging', 'active', 'draining', 'archived')),
  graph_json TEXT NOT NULL CHECK (json_valid(graph_json)),
  registered_at TEXT NOT NULL,
  PRIMARY KEY (flow_id, version)
);

CREATE TABLE IF NOT EXISTS runtime_flow_active (
  flow_id TEXT PRIMARY KEY NOT NULL,
  active_version TEXT NOT NULL,
  previous_version TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (flow_id, active_version)
    REFERENCES runtime_flow_registry(flow_id, version)
    ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (flow_id, previous_version)
    REFERENCES runtime_flow_registry(flow_id, version)
    ON UPDATE CASCADE
);

CREATE TRIGGER IF NOT EXISTS trg_runtime_flow_active_insert
AFTER INSERT ON runtime_flow_active
BEGIN
  UPDATE runtime_flow_registry
     SET status = 'active'
   WHERE flow_id = NEW.flow_id AND version = NEW.active_version;
END;

CREATE TRIGGER IF NOT EXISTS trg_runtime_flow_active_update
AFTER UPDATE OF active_version ON runtime_flow_active
BEGIN
  UPDATE runtime_flow_registry
     SET status = 'draining'
   WHERE flow_id = NEW.flow_id
     AND version = OLD.active_version
     AND OLD.active_version <> NEW.active_version;
  UPDATE runtime_flow_registry
     SET status = 'active'
   WHERE flow_id = NEW.flow_id AND version = NEW.active_version;
END;

CREATE TABLE IF NOT EXISTS runtime_flow_artifacts (
  flow_id TEXT NOT NULL,
  version TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (flow_id, version)
);

CREATE TABLE IF NOT EXISTS runtime_events (
  run_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
  flow_id TEXT NOT NULL,
  flow_version TEXT NOT NULL,
  node_id TEXT,
  node_version TEXT,
  attempt INTEGER,
  node_sequence INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  kind TEXT NOT NULL,
  port_id TEXT,
  stream_id TEXT,
  trace_id TEXT,
  parent_event_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (run_id, event_sequence),
  FOREIGN KEY (run_id) REFERENCES runtime_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runtime_events_run_sequence
  ON runtime_events(run_id, event_sequence);

CREATE TABLE IF NOT EXISTS runtime_variables (
  name TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  updated_at TEXT NOT NULL
);
