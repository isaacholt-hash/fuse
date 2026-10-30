-- 0045_network_grants: where sandboxed commands may use the network (M8 step 10, WF-07). See
-- docs/data-model.md. Never edit once shipped.
--
-- A sandboxed command has no network unless its chat, or one of the folders it works in, was
-- allowed it. Asked the first time a command seems to need it; removable.
CREATE TABLE network_grants (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  scope_kind   TEXT NOT NULL CHECK (scope_kind IN ('thread', 'folder')),
  scope_id     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (workspace_id, scope_kind, scope_id)
);
