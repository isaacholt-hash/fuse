-- 0051_schedules: scheduled tasks (M10 step 9, AG-07). See docs/data-model.md.
-- Never edit once shipped.
--
-- A saved prompt that the runner on HULK starts as a run, in a new chat in its project, once
-- at a time or every day or week at a time. Times are the server's local time. Soft-deleted,
-- like projects. The desktop shows none until sync.
CREATE TABLE schedules (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  project_id    TEXT NOT NULL REFERENCES projects(id),
  name          TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'code' CHECK (kind IN ('code', 'work')),
  mode          TEXT NOT NULL DEFAULT 'ask' CHECK (mode IN ('plan', 'ask', 'auto_edit')),
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  cap_micro_usd INTEGER NOT NULL,
  -- 'once': at `once_at`; 'daily' and 'weekly': at `minute` past midnight, weekly on `weekday`
  -- (0 is Sunday).
  repeat        TEXT NOT NULL CHECK (repeat IN ('once', 'daily', 'weekly')),
  once_at       INTEGER,
  minute        INTEGER NOT NULL DEFAULT 0 CHECK (minute BETWEEN 0 AND 1439),
  weekday       INTEGER CHECK (weekday BETWEEN 0 AND 6),
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- When it runs next; null once a one-off has run, or while it's switched off.
  next_at       INTEGER,
  last_run_id   TEXT REFERENCES runs(id),
  last_thread_id TEXT REFERENCES threads(id),
  -- 'done', 'paused', 'stopped' or 'error', with the run's note and its last step on a failure.
  last_status   TEXT,
  last_note     TEXT,
  last_at       INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX schedules_due ON schedules (workspace_id, next_at);
