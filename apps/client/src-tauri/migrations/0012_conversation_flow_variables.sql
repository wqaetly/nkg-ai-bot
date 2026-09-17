ALTER TABLE conversations ADD COLUMN flow_variables_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(flow_variables_json) AND json_type(flow_variables_json) = 'object');
