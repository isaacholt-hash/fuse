-- 0029_repo: a project's linked repository for the coding agent (M6 step 3, CA-01).
-- See docs/data-model.md. Never edit once shipped.

-- The folder, resolved when linked; NULL when none. Rust reads it from here for every file
-- operation, never from the frontend.
ALTER TABLE projects ADD COLUMN repo_root TEXT;
-- Whether the agent may read secret-looking files (.env, keys) in it.
ALTER TABLE projects ADD COLUMN repo_read_sensitive INTEGER NOT NULL DEFAULT 0
  CHECK (repo_read_sensitive IN (0, 1));
