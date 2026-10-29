-- 0028_egress: which providers may receive what (M5 step 8, SE-13). See docs/data-model.md.
-- Never edit once shipped.

-- Per project: Normal, Local only (nothing leaves the device) or Cloud only (never a local
-- model, M6), and whether its content may be sent to a provider to embed for search.
ALTER TABLE projects ADD COLUMN privacy_mode TEXT NOT NULL DEFAULT 'normal'
  CHECK (privacy_mode IN ('normal', 'local_only', 'cloud_only'));
ALTER TABLE projects ADD COLUMN allow_embeddings INTEGER NOT NULL DEFAULT 1
  CHECK (allow_embeddings IN (0, 1));

-- A provider allowed or blocked everywhere (project_id NULL) or in one project; a project's
-- rule wins over the global one. No row: allowed.
CREATE TABLE egress_rules (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  project_id   TEXT REFERENCES projects(id),
  provider     TEXT NOT NULL,
  allow        INTEGER NOT NULL CHECK (allow IN (0, 1)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX egress_rules_one ON egress_rules (workspace_id, COALESCE(project_id, ''), provider);

-- A knowledge file that is searched on this device only, never sent (SE-13 per record).
ALTER TABLE files ADD COLUMN may_send INTEGER NOT NULL DEFAULT 1 CHECK (may_send IN (0, 1));
