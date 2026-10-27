-- 0003_web_search: web search (M1 step 4). See docs/data-model.md. Never edit once shipped.

-- Searches are billed per call on top of tokens (data/models.json tool_prices).
ALTER TABLE messages ADD COLUMN web_search_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_log ADD COLUMN web_search_calls INTEGER NOT NULL DEFAULT 0;

-- The composer's search toggle, remembered per thread.
ALTER TABLE threads ADD COLUMN web_search INTEGER NOT NULL DEFAULT 0 CHECK (web_search IN (0, 1));

-- Sources cited by an answer, in the order they were first cited.
CREATE TABLE message_citations (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  message_id   TEXT NOT NULL REFERENCES messages(id),
  ordinal      INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('chunk', 'web')),
  url          TEXT,
  title        TEXT,
  chunk_id     TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX message_citations_message ON message_citations (message_id, ordinal);
