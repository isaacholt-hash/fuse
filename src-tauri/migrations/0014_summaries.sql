-- 0014_summaries: rolling summaries for long threads (M2 step 7, PM-06, RT-05).
-- See docs/data-model.md. Never edit once shipped.

-- Older turns, up to and including `upto_message_id`, sent to the model as this summary instead.
-- A summary applies while that message is on the thread's path (branches have their own).
CREATE TABLE thread_summaries (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  thread_id       TEXT NOT NULL REFERENCES threads(id),
  upto_message_id TEXT NOT NULL REFERENCES messages(id),
  summary         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX thread_summaries_thread ON thread_summaries (thread_id, created_at);
