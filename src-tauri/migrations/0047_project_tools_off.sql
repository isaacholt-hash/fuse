-- 0047_project_tools_off: tools a project switched off (M9 step 1, AG-01). See
-- docs/data-model.md. Never edit once shipped.
--
-- Every tool is on unless its project has a row here. Runs outside a project have every tool.
-- The tools a run needs to find its way around its folders can't be switched off.
CREATE TABLE project_tools_off (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  project_id   TEXT NOT NULL REFERENCES projects(id),
  tool         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (workspace_id, project_id, tool)
);
