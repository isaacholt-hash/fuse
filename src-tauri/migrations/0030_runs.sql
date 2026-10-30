-- 0030_runs: coding runs and their steps (M6 step 5, CA-07, CA-04, CA-09). See docs/data-model.md.
-- Never edit once shipped.
--
-- request_log gains the 'agent' purpose. SQLite can't change a CHECK constraint in place, so the
-- table is rebuilt the documented way (as in 0026): create, copy, drop, rename. Migrations run
-- with foreign keys off and every key is checked afterwards (db.rs `migrate`), so messages keep
-- pointing at "request_log" throughout. A backup is made first (PL-11).

CREATE TABLE request_log_new (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  user_id             TEXT NOT NULL REFERENCES users(id),
  thread_id           TEXT REFERENCES threads(id),
  message_id          TEXT, -- no FK: messages reference request_log too; set after both rows exist
  purpose             TEXT NOT NULL CHECK (purpose IN
                        ('chat', 'key_test', 'title', 'classify', 'memory', 'summary', 'embed', 'agent')),
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  attempt             INTEGER NOT NULL DEFAULT 1,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd      INTEGER NOT NULL DEFAULT 0,
  price_version       TEXT,
  latency_ms          INTEGER,
  ttft_ms             INTEGER,
  http_status         INTEGER,
  error_code          TEXT,
  error_message       TEXT,
  provider_request_id TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  web_search_calls    INTEGER NOT NULL DEFAULT 0,
  tier                TEXT,
  route_rule_id       TEXT
);
INSERT INTO request_log_new (id, workspace_id, user_id, thread_id, message_id, purpose, provider,
  model, attempt, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens,
  reasoning_tokens, cost_micro_usd, price_version, latency_ms, ttft_ms, http_status, error_code,
  error_message, provider_request_id, created_at, updated_at, web_search_calls, tier, route_rule_id)
SELECT id, workspace_id, user_id, thread_id, message_id, purpose, provider,
  model, attempt, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens,
  reasoning_tokens, cost_micro_usd, price_version, latency_ms, ttft_ms, http_status, error_code,
  error_message, provider_request_id, created_at, updated_at, web_search_calls, tier, route_rule_id
FROM request_log;
DROP TABLE request_log;
ALTER TABLE request_log_new RENAME TO request_log;
CREATE INDEX request_log_recent ON request_log (workspace_id, created_at DESC);

-- A coding run: one task in a project's linked repository, on one model, with a cost cap.
CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  project_id      TEXT NOT NULL REFERENCES projects(id),
  -- The chat and the answer the run shows in, when it was started from one.
  thread_id       TEXT REFERENCES threads(id),
  message_id      TEXT REFERENCES messages(id),
  task            TEXT NOT NULL,
  -- CA-04. Only 'plan' (read-only) in step 5; edits and commands come with later steps.
  mode            TEXT NOT NULL DEFAULT 'plan' CHECK (mode IN ('plan')),
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running', 'paused', 'done', 'stopped', 'error')),
  cap_micro_usd   INTEGER NOT NULL,
  spent_micro_usd INTEGER NOT NULL DEFAULT 0,
  -- Why it paused, stopped or failed, in plain words.
  note            TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX runs_by_project ON runs (workspace_id, project_id, created_at DESC);

-- One model turn or one tool call. Model steps keep the turn exactly as the provider sent it
-- (`native`, JSON), so a run can be resumed and the loop replayed unchanged.
CREATE TABLE run_steps (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  run_id         TEXT NOT NULL REFERENCES runs(id),
  seq            INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('model', 'tool')),
  -- Model steps: what it wrote this turn, and the turn itself.
  text           TEXT,
  native         TEXT,
  request_id     TEXT REFERENCES request_log(id),
  -- Tool steps.
  tool_name      TEXT,
  tool_call_id   TEXT,
  input          TEXT,
  output         TEXT,
  is_error       INTEGER NOT NULL DEFAULT 0 CHECK (is_error IN (0, 1)),
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (run_id, seq)
);
