-- 0005_projects: projects (M1 step 6, PM-01, without knowledge files). See docs/data-model.md.
-- Never edit once shipped.

CREATE TABLE projects (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  name             TEXT NOT NULL,
  instructions     TEXT NOT NULL DEFAULT '',
  -- The model new chats in this project start on; NULL means the last model used.
  -- Replaced by a default tier once tiers exist (step 9).
  default_provider TEXT,
  default_model    TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  CHECK ((default_provider IS NULL) = (default_model IS NULL))
);
CREATE INDEX projects_workspace ON projects (workspace_id, name);

-- A thread belongs to at most one project and can move between them.
ALTER TABLE threads ADD COLUMN project_id TEXT REFERENCES projects(id);
CREATE INDEX threads_project ON threads (project_id);
