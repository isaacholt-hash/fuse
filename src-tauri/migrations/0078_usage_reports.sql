-- M18.3: provider usage and cost reports, read with owner-configured reporting credentials or
-- imported from CSV. Aggregate snapshots stay on the installation that collected them; they
-- never become request_log spend. One row per provider, kind, UTC day bucket and scope; a later
-- report for the same key replaces it (late corrections).
CREATE TABLE usage_report_rows (
 id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 provider TEXT NOT NULL CHECK(provider IN('openai','anthropic')),
 kind TEXT NOT NULL CHECK(kind IN('cost','usage')),
 source TEXT NOT NULL CHECK(source IN('api','csv')),
 bucket_start INTEGER NOT NULL, bucket_end INTEGER NOT NULL CHECK(bucket_end>bucket_start),
 scope TEXT NOT NULL DEFAULT '', key_ref TEXT NOT NULL DEFAULT '',
 model TEXT NOT NULL DEFAULT '', line_item TEXT NOT NULL DEFAULT '',
 currency TEXT NOT NULL DEFAULT 'usd',
 amount_micro INTEGER, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
 requests INTEGER, run_id TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(workspace_id,user_id,provider,kind,source,bucket_start,scope,key_ref,model,line_item)
);
CREATE INDEX usage_report_rows_day ON usage_report_rows(workspace_id,user_id,provider,bucket_start);
CREATE TABLE usage_report_runs (
 id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 provider TEXT NOT NULL CHECK(provider IN('openai','anthropic')),
 source TEXT NOT NULL CHECK(source IN('api','csv')),
 state TEXT NOT NULL CHECK(state IN('running','ok','auth','rate_limited','error')),
 window_start INTEGER NOT NULL, window_end INTEGER NOT NULL,
 pages INTEGER NOT NULL DEFAULT 0, rows INTEGER NOT NULL DEFAULT 0,
 refreshed_at INTEGER, message TEXT CHECK(message IS NULL OR length(message)<=300),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX usage_report_runs_recent ON usage_report_runs(workspace_id,user_id,provider,created_at);
