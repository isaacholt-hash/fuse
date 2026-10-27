-- 0001_init: M0 core tables. See docs/data-model.md. Never edit once shipped; add a new migration.
-- Conventions: UUIDv7 TEXT ids, Unix-ms INTEGER timestamps, money in micro-dollars, workspace_id + user_id everywhere.

CREATE TABLE workspaces (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  CHECK (workspace_id = id)
);

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  CHECK (user_id = id)
);

CREATE TABLE threads (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL DEFAULT 'New chat',
  title_source    TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('user', 'auto')),
  last_message_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX threads_recent ON threads (workspace_id, last_message_at DESC);

CREATE TABLE request_log (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  user_id             TEXT NOT NULL REFERENCES users(id),
  thread_id           TEXT REFERENCES threads(id),
  message_id          TEXT, -- no FK: messages reference request_log too; set after both rows exist
  purpose             TEXT NOT NULL CHECK (purpose IN ('chat', 'key_test', 'title', 'classify', 'memory', 'summary', 'embed')),
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
  updated_at          INTEGER NOT NULL
);
CREATE INDEX request_log_recent ON request_log (workspace_id, created_at DESC);

CREATE TABLE messages (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  user_id             TEXT NOT NULL REFERENCES users(id),
  thread_id           TEXT NOT NULL REFERENCES threads(id),
  parent_id           TEXT REFERENCES messages(id), -- tree from day one (CH-04 branching)
  role                TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content             TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'streaming', 'stopped', 'error')),
  error_code          TEXT,
  error_message       TEXT,
  provider            TEXT,
  model               TEXT,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd      INTEGER NOT NULL DEFAULT 0,
  price_version       TEXT,
  latency_ms          INTEGER,
  ttft_ms             INTEGER,
  request_id          TEXT REFERENCES request_log(id),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER
);
CREATE INDEX messages_by_thread ON messages (thread_id, created_at);

CREATE TABLE schema_meta (
  key          TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  value        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Default tenant for v1 (single user). Fixed ids, mirrored in src/storage/defaults.ts.
INSERT INTO workspaces (id, workspace_id, user_id, name, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000001',
   '00000000-0000-7000-8000-000000000002', 'Default', 0, 0);
INSERT INTO users (id, workspace_id, user_id, display_name, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001',
   '00000000-0000-7000-8000-000000000002', 'Isaac', 0, 0);
