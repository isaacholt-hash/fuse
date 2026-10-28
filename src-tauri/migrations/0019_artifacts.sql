-- 0019_artifacts: artifacts and their versions (M2 steps 18-19, AR-01, AR-02).
-- See docs/data-model.md. Never edit once shipped.

-- A document, code file, page or diagram from a chat, shown in the side panel.
CREATE TABLE artifacts (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  thread_id    TEXT NOT NULL REFERENCES threads(id),
  -- The model's id for it within the thread; the same key again makes a new version.
  key          TEXT NOT NULL,
  title        TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('markdown', 'code', 'html', 'svg', 'mermaid', 'react')),
  language     TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE UNIQUE INDEX artifacts_thread_key ON artifacts (workspace_id, thread_id, key);

-- Every change is a version: from the model (an answer), from the user (an edit), or a restore.
CREATE TABLE artifact_versions (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  artifact_id  TEXT NOT NULL REFERENCES artifacts(id),
  version      INTEGER NOT NULL,
  content      TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('model', 'user', 'restore')),
  message_id   TEXT REFERENCES messages(id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX artifact_versions_order ON artifact_versions (artifact_id, version);
