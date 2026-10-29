-- 0026_typed_memory: provider-neutral typed memory (M5 step 2, PM-12, PM-13, PM-14).
-- See docs/data-model.md. Never edit once shipped.
--
-- SQLite can't change a CHECK constraint in place, so `memories` and `memory_proposals` are
-- rebuilt the documented way: create the new table, copy, drop the old one, rename. FUSE runs
-- migrations with foreign keys off and checks them all afterwards (db.rs `migrate`), so rows in
-- message_memories keep pointing at "memories" throughout. A backup is made first (PL-11).

CREATE TABLE memories_typed (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  user_id            TEXT NOT NULL REFERENCES users(id),
  text               TEXT NOT NULL,
  -- What sort of record this is (PM-12). Decisions and tasks carry their own fields below.
  kind               TEXT NOT NULL CHECK (kind IN
                       ('fact', 'preference', 'person', 'constraint', 'decision', 'task', 'source')),
  -- Where it applies (PM-13). Workspace equals global while there is one workspace.
  scope              TEXT NOT NULL DEFAULT 'global'
                       CHECK (scope IN ('global', 'workspace', 'project', 'conversation')),
  project_id         TEXT REFERENCES projects(id),
  -- The chat a conversation-scoped record belongs to.
  thread_id          TEXT REFERENCES threads(id),
  -- Provenance (PM-14): who said so, where it came from, how it was found.
  authority          TEXT NOT NULL CHECK (authority IN ('you', 'imported', 'extracted')),
  source_thread_id   TEXT REFERENCES threads(id),
  source_message_id  TEXT REFERENCES messages(id),
  source_artifact_id TEXT REFERENCES artifacts(id),
  -- 'typed', 'chat' (suggested after a chat), 'import' (pasted from another app).
  extraction_method  TEXT NOT NULL DEFAULT 'typed',
  extraction_model   TEXT,
  confidence         INTEGER NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  last_verified_at   INTEGER,
  expires_at         INTEGER,
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'excluded', 'superseded', 'expired', 'deleted')),
  -- Privacy: sensitive records are flagged; may_send = 0 never leaves the device (SE-13).
  sensitivity        TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'sensitive')),
  may_send           INTEGER NOT NULL DEFAULT 1 CHECK (may_send IN (0, 1)),
  superseded_by_id   TEXT REFERENCES memories(id),
  -- Decisions (PM-15): why, and what else was considered (a JSON array of strings).
  rationale          TEXT,
  alternatives       TEXT,
  -- Tasks (PM-16): progress, and the task ids it waits on (a JSON array).
  task_status        TEXT CHECK (task_status IN ('open', 'doing', 'done', 'dropped')),
  depends_on         TEXT,
  -- Sync-ready (PL-04): bumped on every change, and the device that made it.
  revision           INTEGER NOT NULL DEFAULT 1,
  device_id          TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER,
  CHECK ((scope = 'project') = (project_id IS NOT NULL) OR scope = 'conversation'),
  CHECK ((scope = 'conversation') = (thread_id IS NOT NULL)),
  CHECK ((kind = 'task') = (task_status IS NOT NULL))
);

INSERT INTO memories_typed (id, workspace_id, user_id, text, kind, scope, project_id, authority,
  source_thread_id, extraction_method, confidence, status, superseded_by_id, created_at,
  updated_at, deleted_at)
SELECT m.id, m.workspace_id, m.user_id, m.text,
  CASE m.category WHEN 'project' THEN 'fact' ELSE m.category END,
  m.scope, m.project_id,
  CASE
    WHEN m.source_thread_id IN (SELECT thread_id FROM imports) THEN 'imported'
    WHEN m.source_thread_id IS NOT NULL THEN 'extracted'
    ELSE 'you'
  END,
  m.source_thread_id,
  CASE
    WHEN m.source_thread_id IN (SELECT thread_id FROM imports) THEN 'import'
    WHEN m.source_thread_id IS NOT NULL THEN 'chat'
    ELSE 'typed'
  END,
  m.confidence,
  CASE
    WHEN m.deleted_at IS NOT NULL THEN 'deleted'
    WHEN m.superseded_by_id IS NOT NULL THEN 'superseded'
    ELSE 'active'
  END,
  m.superseded_by_id, m.created_at, m.updated_at, m.deleted_at
FROM memories m;

DROP TABLE memories;
ALTER TABLE memories_typed RENAME TO memories;
CREATE INDEX memories_workspace ON memories (workspace_id, status, kind);
CREATE INDEX memories_project ON memories (workspace_id, project_id);

CREATE TABLE memory_proposals_typed (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  op               TEXT NOT NULL CHECK (op IN ('add', 'update', 'delete')),
  memory_id        TEXT REFERENCES memories(id),
  text             TEXT NOT NULL DEFAULT '',
  -- Never 'decision': decisions are only ever added by you (PM-15).
  kind             TEXT NOT NULL CHECK (kind IN
                     ('fact', 'preference', 'person', 'constraint', 'task', 'source')),
  project_id       TEXT REFERENCES projects(id),
  confidence       INTEGER NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  source_thread_id TEXT REFERENCES threads(id),
  -- 'chat' (suggested after a chat) or 'import' (pasted from another app).
  origin           TEXT NOT NULL DEFAULT 'chat' CHECK (origin IN ('chat', 'import')),
  extraction_model TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK ((op = 'add') = (memory_id IS NULL))
);

INSERT INTO memory_proposals_typed (id, workspace_id, user_id, op, memory_id, text, kind,
  project_id, confidence, source_thread_id, origin, status, created_at, updated_at)
SELECT id, workspace_id, user_id, op, memory_id, text,
  CASE category WHEN 'project' THEN 'fact' ELSE category END,
  project_id, confidence, source_thread_id,
  CASE WHEN source_thread_id IS NULL THEN 'import' ELSE 'chat' END,
  status, created_at, updated_at
FROM memory_proposals;

DROP TABLE memory_proposals;
ALTER TABLE memory_proposals_typed RENAME TO memory_proposals;
CREATE INDEX memory_proposals_status ON memory_proposals (workspace_id, status);
