-- 0016_vectors: text chunks and their embeddings for retrieval (M2 step 13, MM-11, FK-02).
-- See docs/data-model.md. Never edit once shipped.

-- A piece of text from a file (later: memories, past chats), small enough to embed and cite.
CREATE TABLE chunks (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  source_kind  TEXT NOT NULL CHECK (source_kind IN ('file', 'memory', 'message')),
  source_id    TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  text         TEXT NOT NULL,
  tokens       INTEGER NOT NULL,
  -- Where it came from, for citations: a PDF page or a line range.
  page         INTEGER,
  line_start   INTEGER,
  line_end     INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX chunks_source ON chunks (workspace_id, source_kind, source_id, ordinal);

-- One vector per chunk per embedding model: little-endian float32, L2-normalised, as base64
-- (SQL values cross into Rust as JSON, which has no bytes type).
CREATE TABLE chunk_vectors (
  chunk_id     TEXT NOT NULL REFERENCES chunks(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  model        TEXT NOT NULL,
  dims         INTEGER NOT NULL,
  vector       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, model)
);
