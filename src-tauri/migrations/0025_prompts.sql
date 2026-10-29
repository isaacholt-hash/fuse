-- 0025_prompts: the prompt library (M4 step 13, CH-12). See docs/data-model.md.
-- Never edit once shipped.

-- Saved prompts, global (project_id NULL) or for one project; {{name}} marks a variable.
CREATE TABLE prompts (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  project_id   TEXT REFERENCES projects(id),
  name         TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX prompts_by_workspace ON prompts (workspace_id, name);
