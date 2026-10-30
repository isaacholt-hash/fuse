-- 0037_local_shadow: shadow checks of the local model (M7 step 9, LL-09). See docs/data-model.md.
-- Never edit once shipped.
--
-- In the first week after a local model is installed, about 1 in 10 housekeeping jobs it did
-- also runs on the cloud Cheap model. Only timings, lengths and whether the two agreed are kept:
-- never the text (LL-07: no prompt or reply text in telemetry).
CREATE TABLE local_shadow (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  purpose      TEXT NOT NULL,
  local_model  TEXT NOT NULL,
  cloud_model  TEXT NOT NULL,
  local_ms     INTEGER NOT NULL,
  cloud_ms     INTEGER NOT NULL,
  local_chars  INTEGER NOT NULL,
  cloud_chars  INTEGER NOT NULL,
  -- 1 when both replies are the same once spacing and case are ignored.
  same         INTEGER NOT NULL CHECK (same IN (0, 1)),
  created_at   INTEGER NOT NULL
);
CREATE INDEX local_shadow_by_time ON local_shadow (workspace_id, created_at);
