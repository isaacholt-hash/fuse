-- 0002_files: attachments (M1 step 2). See docs/data-model.md. Never edit once shipped.
-- Bytes live on disk under the app data dir (files/<sha256>); these rows hold metadata only.

CREATE TABLE files (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  name           TEXT NOT NULL,
  mime           TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  storage_path   TEXT NOT NULL,
  width          INTEGER,
  height         INTEGER,
  token_estimate INTEGER,
  parse_status   TEXT NOT NULL DEFAULT 'ready' CHECK (parse_status IN ('pending', 'ready', 'error')),
  parse_error    TEXT,
  project_id     TEXT,
  thread_id      TEXT REFERENCES threads(id),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX files_sha256 ON files (workspace_id, sha256);

CREATE TABLE message_files (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  message_id   TEXT NOT NULL REFERENCES messages(id),
  file_id      TEXT NOT NULL REFERENCES files(id),
  ordinal      INTEGER NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'whole' CHECK (mode IN ('whole', 'retrieval')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX message_files_message ON message_files (message_id, ordinal);
