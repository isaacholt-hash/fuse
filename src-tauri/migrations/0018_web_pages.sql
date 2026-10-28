-- 0018_web_pages: links read for chats, cached for 24 hours (M2 step 17, FK-06).
-- See docs/data-model.md. Never edit once shipped.

-- The page's readable text is an ordinary text file (files), so it's sent, searched and cited
-- like any attachment. This maps a link to that file and when it was read.
CREATE TABLE web_pages (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  url          TEXT NOT NULL,
  file_id      TEXT NOT NULL REFERENCES files(id),
  title        TEXT NOT NULL,
  fetched_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX web_pages_url ON web_pages (workspace_id, url, fetched_at);
