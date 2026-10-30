-- 0031_run_changes: file changes made by coding runs, kept so each can be shown as a diff and
-- undone (M6 step 6, CA-02). See docs/data-model.md. Never edit once shipped.
--
-- `runs.mode` gains the modes that change things (CA-04): 'ask' (asks before each edit and
-- command, M6 step 8) and 'auto_edit' (edits go ahead, commands ask). SQLite can't change a
-- CHECK in place, so `runs` is rebuilt the documented way (as in 0026 and 0030): run_steps keeps
-- pointing at "runs" throughout, with foreign keys checked after the migration.

CREATE TABLE runs_new (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  project_id      TEXT NOT NULL REFERENCES projects(id),
  thread_id       TEXT REFERENCES threads(id),
  message_id      TEXT REFERENCES messages(id),
  task            TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'plan' CHECK (mode IN ('plan', 'ask', 'auto_edit')),
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running', 'paused', 'done', 'stopped', 'error')),
  cap_micro_usd   INTEGER NOT NULL,
  spent_micro_usd INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
INSERT INTO runs_new SELECT id, workspace_id, user_id, project_id, thread_id, message_id, task,
  mode, provider, model, status, cap_micro_usd, spent_micro_usd, note, created_at, updated_at
FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
CREATE INDEX runs_by_project ON runs (workspace_id, project_id, created_at DESC);

-- One file changed by a run: created (before NULL), edited, deleted (after NULL) or moved
-- (from_path set). Undoing puts `before` back, and is refused if the file no longer holds `after`.
CREATE TABLE run_changes (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  run_id       TEXT NOT NULL REFERENCES runs(id),
  step_id      TEXT REFERENCES run_steps(id),
  path         TEXT NOT NULL,
  from_path    TEXT,
  before       TEXT,
  after        TEXT,
  status       TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'undone')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX run_changes_by_run ON run_changes (workspace_id, run_id, created_at);
