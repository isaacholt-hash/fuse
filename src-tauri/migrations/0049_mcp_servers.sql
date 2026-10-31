-- 0049_mcp_servers: MCP servers added in Settings (M9 step 8, AG-02). See docs/data-model.md.
-- Never edit once shipped.
--
-- A server is a local command (stdio) or a remote URL (http). Its environment variables' values
-- are in the OS keychain, never here: only their names are kept. A local server runs in the
-- sandbox, with the network only when `network` is on. Soft-deleted, like projects.
CREATE TABLE mcp_servers (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  transport    TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
  command      TEXT,
  args         TEXT NOT NULL DEFAULT '[]',
  url          TEXT,
  env_names    TEXT NOT NULL DEFAULT '[]',
  network      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);

-- The servers a project's chats and runs may use (step 9).
CREATE TABLE project_mcp_servers (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  project_id   TEXT NOT NULL REFERENCES projects(id),
  server_id    TEXT NOT NULL REFERENCES mcp_servers(id),
  created_at   INTEGER NOT NULL,
  UNIQUE (workspace_id, project_id, server_id)
);
