-- 0040_folders: folders as their own records (M8 step 1, WF-02). See docs/data-model.md.
-- Never edit once shipped.
--
-- A folder on this computer that FUSE may work in, granted once. A project can link several
-- (all its chats use them) and a chat can have its own. The project's M6 linked repository
-- (projects.repo_root) moves here as the project's first folder; that column is no longer read.
CREATE TABLE folders (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  -- The absolute path as Rust resolved it when it was granted.
  path           TEXT NOT NULL,
  -- CA-01: whether secret-looking files (.env, keys) in it may be read.
  read_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (read_sensitive IN (0, 1)),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (workspace_id, path)
);

CREATE TABLE project_folders (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  project_id   TEXT NOT NULL REFERENCES projects(id),
  folder_id    TEXT NOT NULL REFERENCES folders(id),
  created_at   INTEGER NOT NULL,
  UNIQUE (project_id, folder_id)
);

CREATE TABLE thread_folders (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  thread_id    TEXT NOT NULL REFERENCES threads(id),
  folder_id    TEXT NOT NULL REFERENCES folders(id),
  created_at   INTEGER NOT NULL,
  UNIQUE (thread_id, folder_id)
);

-- Existing linked repositories become folders (one per path), linked to their projects.
INSERT OR IGNORE INTO folders (id, workspace_id, user_id, path, read_sensitive, created_at, updated_at)
  SELECT 'fold-' || id, workspace_id, user_id, repo_root, repo_read_sensitive, created_at, updated_at
  FROM projects WHERE repo_root IS NOT NULL AND deleted_at IS NULL;

INSERT INTO project_folders (id, workspace_id, user_id, project_id, folder_id, created_at)
  SELECT 'pf-' || p.id, p.workspace_id, p.user_id, p.id, f.id, p.created_at
  FROM projects p JOIN folders f ON f.workspace_id = p.workspace_id AND f.path = p.repo_root
  WHERE p.repo_root IS NOT NULL AND p.deleted_at IS NULL;
