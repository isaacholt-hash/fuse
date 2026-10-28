-- 0022_thread_organise: pin, archive and tags for chats (M4 step 1, CH-02). See docs/data-model.md.
-- Never edit once shipped.

-- Pinned chats sit at the top of the sidebar; archived ones are hidden until asked for.
ALTER TABLE threads ADD COLUMN pinned_at INTEGER;
ALTER TABLE threads ADD COLUMN archived_at INTEGER;

-- A chat's tags: lowercase, no spaces, one row per tag.
CREATE TABLE thread_tags (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  thread_id    TEXT NOT NULL REFERENCES threads(id),
  tag          TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX thread_tags_once ON thread_tags (thread_id, tag);
CREATE INDEX thread_tags_by_tag ON thread_tags (workspace_id, tag);
