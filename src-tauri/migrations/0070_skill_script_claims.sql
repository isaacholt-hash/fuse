-- Content-free owner-local dispatch markers. A lost acknowledgement cannot replay a script.
CREATE TABLE skill_script_claims (
 id TEXT PRIMARY KEY NOT NULL,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL,
 script_sha256 TEXT NOT NULL CHECK(length(script_sha256)=64),
 state TEXT NOT NULL CHECK(state IN('claimed','complete','failed')),
 exit_code INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX skill_script_claims_run ON skill_script_claims(workspace_id,run_id,created_at);
