-- 0046_folder_files: documents in project folders as knowledge (M8 step 11, FK-07). See
-- docs/data-model.md. Never edit once shipped.
--
-- One row per document found in a folder: where it is, what its bytes hashed to, and the file
-- record holding its text (indexed like any knowledge file and linked to every project that has
-- the folder, through project_files). A changed document gets a new file record; the old one's
-- links and chunks are removed.
CREATE TABLE folder_files (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  folder_id    TEXT NOT NULL REFERENCES folders(id),
  -- Relative to the folder, with / on every platform.
  path         TEXT NOT NULL,
  file_id      TEXT NOT NULL REFERENCES files(id),
  -- SHA-256 of the bytes on disk (not of the stored text).
  sha256       TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  -- Milliseconds since the epoch, as the file system reported; null when it didn't.
  modified_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (workspace_id, folder_id, path)
);
CREATE INDEX folder_files_file ON folder_files (workspace_id, file_id);
