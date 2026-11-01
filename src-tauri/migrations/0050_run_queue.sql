-- 0050_run_queue: runs on HULK (M10 step 6, CA-15). See docs/data-model.md.
-- Never edit once shipped.
--
-- In the web app a run doesn't run in the browser tab: the page asks for it here and the
-- server's runner does it, so closing the tab doesn't stop it. The desktop doesn't use these.

-- What a page asked the runner to do: start a run in a chat, continue one, or stop one.
-- `input` is JSON: the chat run's input for 'start' (models as provider and id), the run's id
-- for 'continue' and 'stop'.
CREATE TABLE run_requests (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL CHECK (kind IN ('start', 'continue', 'stop')),
  input        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'taken', 'done', 'failed')),
  -- Not a foreign key: a stop may name a run that's already gone.
  run_id       TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX run_requests_queued ON run_requests (workspace_id, status, created_at);

-- A question a run on the server is waiting on ("Waiting for you"). Any signed-in page may
-- answer it; the run goes on when `answer` is set. `request` is the approval as JSON.
CREATE TABLE run_approvals (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  run_id       TEXT NOT NULL REFERENCES runs(id),
  request      TEXT NOT NULL,
  answer       TEXT,
  created_at   INTEGER NOT NULL,
  answered_at  INTEGER
);
CREATE INDEX run_approvals_open ON run_approvals (workspace_id, answered_at);

-- The text of a run's turn while it's still streaming, so a page can show it live.
CREATE TABLE run_live (
  run_id       TEXT PRIMARY KEY REFERENCES runs(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  streaming    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
