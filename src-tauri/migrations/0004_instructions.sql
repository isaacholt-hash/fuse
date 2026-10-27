-- 0004_instructions: custom instructions (M1 step 5, CH-05). See docs/data-model.md. Never edit once shipped.

-- Global instructions, one row per user. Project instructions arrive with projects (step 6).
CREATE TABLE user_instructions (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  about_you     TEXT NOT NULL DEFAULT '',
  how_to_answer TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, user_id)
);

-- Instructions for one thread only.
ALTER TABLE threads ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
