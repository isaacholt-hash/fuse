-- 0017_project_files: project knowledge (M2 step 15, PM-09). See docs/data-model.md.
-- Never edit once shipped.

-- Files that belong to a project: indexed once, searched for every chat in it.
CREATE TABLE project_files (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  project_id   TEXT NOT NULL REFERENCES projects(id),
  file_id      TEXT NOT NULL REFERENCES files(id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE INDEX project_files_project ON project_files (workspace_id, project_id);
