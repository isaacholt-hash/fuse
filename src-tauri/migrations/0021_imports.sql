-- 0021_imports: chats imported from other apps (M3 steps 8-9, PL-08). See docs/data-model.md.
-- Never edit once shipped.

-- Which outside conversation became which thread, so an import can be run again safely.
CREATE TABLE imports (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  source       TEXT NOT NULL CHECK (source IN ('chatgpt', 'claude')),
  external_id  TEXT NOT NULL,
  thread_id    TEXT NOT NULL REFERENCES threads(id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX imports_once ON imports (workspace_id, source, external_id);
