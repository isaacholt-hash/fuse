-- Owner-local execution checkpoints. Completed evidence/report versions use existing portable tables.
CREATE TABLE research_state (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  data TEXT NOT NULL CHECK(json_valid(data)),
  lease TEXT,
  pause_requested INTEGER NOT NULL DEFAULT 0 CHECK(pause_requested IN (0,1)),
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK(stop_requested IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE research_operations (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  run_id TEXT NOT NULL REFERENCES research_state(run_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK(seq>0),
  kind TEXT NOT NULL CHECK(kind IN ('plan','search','read','synthesis','verify')),
  state TEXT NOT NULL CHECK(state IN ('pending','complete','unknown','lost','not_dispatched')),
  input TEXT NOT NULL CHECK(json_valid(input)),
  result TEXT CHECK(result IS NULL OR json_valid(result)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id,run_id,seq)
);
CREATE INDEX research_operations_run ON research_operations(workspace_id,run_id,seq);
