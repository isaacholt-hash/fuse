-- 0041_run_folders: runs work across folders, in any chat (M8 step 2, WF-01, WF-02). See
-- docs/data-model.md. Never edit once shipped.
--
-- A run no longer needs a project: `runs.project_id` becomes optional, and `run_folders` records
-- the folders a run works in (and the name each goes by in its paths), so continuing or undoing
-- it later uses the same ones. `runs.kind` is 'code' (M6) or 'work' (M8 step 3). Rebuilt the
-- documented way (as in 0031); run_steps and run_changes keep pointing at "runs" throughout.

CREATE TABLE runs_new (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  project_id      TEXT REFERENCES projects(id),
  thread_id       TEXT REFERENCES threads(id),
  message_id      TEXT REFERENCES messages(id),
  task            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'code' CHECK (kind IN ('code', 'work')),
  mode            TEXT NOT NULL DEFAULT 'plan' CHECK (mode IN ('plan', 'ask', 'auto_edit')),
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running', 'paused', 'done', 'stopped', 'error')),
  cap_micro_usd   INTEGER NOT NULL,
  spent_micro_usd INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  summary         TEXT,
  summary_upto    INTEGER,
  branch          TEXT,
  plan            TEXT,
  planner         TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
INSERT INTO runs_new (id, workspace_id, user_id, project_id, thread_id, message_id, task, kind, mode,
  provider, model, status, cap_micro_usd, spent_micro_usd, note, summary, summary_upto, branch, plan,
  planner, created_at, updated_at)
SELECT id, workspace_id, user_id, project_id, thread_id, message_id, task, 'code', mode, provider,
  model, status, cap_micro_usd, spent_micro_usd, note, summary, summary_upto, branch, plan, planner,
  created_at, updated_at
FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
CREATE INDEX runs_by_project ON runs (workspace_id, project_id, created_at DESC);
CREATE INDEX runs_by_thread ON runs (workspace_id, thread_id, created_at DESC);

CREATE TABLE run_folders (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  run_id       TEXT NOT NULL REFERENCES runs(id),
  folder_id    TEXT NOT NULL REFERENCES folders(id),
  -- What the run's paths call it when it has more than one folder ("<label>/<path>").
  label        TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (run_id, folder_id),
  UNIQUE (run_id, label)
);

-- Runs from before: their project's first folder (0040), under its own name.
INSERT INTO run_folders (id, workspace_id, user_id, run_id, folder_id, label, ordinal, created_at)
  SELECT 'rf-' || r.id, r.workspace_id, r.user_id, r.id, pf.folder_id, 'repo', 0, r.created_at
  FROM runs r JOIN project_folders pf ON pf.id = (
    SELECT id FROM project_folders WHERE project_id = r.project_id ORDER BY created_at, id LIMIT 1
  );
