-- 0032_permissions: what coding runs may do without asking (M6 step 8, CA-04, AG-04).
-- See docs/data-model.md. Never edit once shipped.

-- The mode a project's coding runs start in: read-only, ask before each edit and command, or
-- edits go ahead (commands still ask). Ask is the default (requirements §17, 2026-10-30).
ALTER TABLE projects ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'ask'
  CHECK (run_mode IN ('plan', 'ask', 'auto_edit'));

-- How each tool call was allowed, for the audit log: it needed nobody ('auto': reads, or edits in
-- Auto-edit), you allowed it, a command you always allow in the project, or you declined it.
ALTER TABLE run_steps ADD COLUMN approval TEXT
  CHECK (approval IN ('auto', 'you', 'always', 'denied'));

-- Commands you always allow in a project, matched exactly. Destructive ones still ask.
CREATE TABLE project_commands (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  project_id   TEXT NOT NULL REFERENCES projects(id),
  command      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (project_id, command)
);
