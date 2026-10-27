-- 0006_memory: memory v1 (M1 step 7, PM-02..PM-05, PM-07). See docs/data-model.md.
-- Never edit once shipped. Vector search (memory_vectors) arrives in M2.

-- Facts FUSE remembers about the user. Only approved facts live here; suggestions wait in
-- memory_proposals. An update keeps the old fact as history via superseded_by_id.
CREATE TABLE memories (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  text             TEXT NOT NULL,
  category         TEXT NOT NULL CHECK (category IN ('preference', 'person', 'project', 'fact')),
  scope            TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'project')),
  project_id       TEXT REFERENCES projects(id),
  source_thread_id TEXT REFERENCES threads(id),
  confidence       INTEGER NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  superseded_by_id TEXT REFERENCES memories(id),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  CHECK ((scope = 'project') = (project_id IS NOT NULL))
);
CREATE INDEX memories_workspace ON memories (workspace_id, deleted_at, superseded_by_id);

-- Changes a Cheap model suggested after a chat (PM-03), waiting for the user's yes or no.
-- Rejected ones are kept so the same suggestion isn't made again.
CREATE TABLE memory_proposals (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  op               TEXT NOT NULL CHECK (op IN ('add', 'update', 'delete')),
  -- The fact to update or delete; NULL for a new fact.
  memory_id        TEXT REFERENCES memories(id),
  text             TEXT NOT NULL DEFAULT '',
  category         TEXT NOT NULL CHECK (category IN ('preference', 'person', 'project', 'fact')),
  project_id       TEXT REFERENCES projects(id),
  confidence       INTEGER NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  source_thread_id TEXT REFERENCES threads(id),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK ((op = 'add') = (memory_id IS NULL))
);
CREATE INDEX memory_proposals_status ON memory_proposals (workspace_id, status);

-- Which memories were sent with which answer (PM-04: the injected set is viewable per message).
CREATE TABLE message_memories (
  message_id   TEXT NOT NULL REFERENCES messages(id),
  memory_id    TEXT NOT NULL REFERENCES memories(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (message_id, memory_id)
);

-- Per-user preferences (never keys).
CREATE TABLE settings (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (workspace_id, user_id, key)
);

-- Memory on or off for one chat (PM-04), and how far its messages were checked for facts.
ALTER TABLE threads ADD COLUMN memory_injection TEXT NOT NULL DEFAULT 'on'
  CHECK (memory_injection IN ('on', 'off'));
ALTER TABLE threads ADD COLUMN memory_checked_at INTEGER;
