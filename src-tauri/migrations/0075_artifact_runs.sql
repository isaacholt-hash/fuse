-- M17.3: owner-local provenance for explicitly approved runs of a Python artifact version.
-- Execution state stays on the device that ran it: never synced or portably exported.
CREATE TABLE artifact_runs (
 id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
 attempt INTEGER NOT NULL CHECK(attempt>=1),
 script_sha256 TEXT NOT NULL CHECK(length(script_sha256)=64),
 inputs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(inputs)),
 state TEXT NOT NULL CHECK(state IN('requested','running','complete','failed','stopped','interrupted')),
 exit_code INTEGER, timed_out INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0,
 elapsed_ms INTEGER, output TEXT NOT NULL DEFAULT '' CHECK(length(output)<=1100000),
 outputs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(outputs)),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(workspace_id,user_id,version_id,attempt)
);
CREATE INDEX artifact_runs_source ON artifact_runs(workspace_id,user_id,artifact_id,created_at,id);
