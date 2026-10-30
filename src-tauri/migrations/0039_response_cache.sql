-- 0039_response_cache: exact-match response cache (M7 step 11, LL-06, RT-13). See
-- docs/data-model.md. Never edit once shipped.
--
-- An answer is reused only for the same request: the key is a SHA-256 of the model, the whole
-- system prompt (instructions, memories, decisions), the messages and the output format, and
-- the row also names its project scope. Entries expire; semantic matching is never used.
CREATE TABLE response_cache (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  key          TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('chat', 'classify')),
  -- A project id, or 'none' for chats outside a project: a hit must match it too.
  scope        TEXT NOT NULL,
  model        TEXT NOT NULL,
  response     TEXT NOT NULL,
  -- What the original call cost, so a hit can say what it saved.
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  hits         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  UNIQUE (workspace_id, key)
);
