-- 0053_thread_kind: two areas, Chat and Code (M10 steps 12 to 17, CH-19). See docs/data-model.md.
-- Never edit once shipped.

-- Which area a thread lives in: a chat, or a Code or Work session. Work sessions live in the Code
-- area with Code ones (same runner, approvals, diffs, cap and handover).
ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'
  CHECK (kind IN ('chat', 'code', 'work'));
-- A thread that already holds a run takes the kind of its last run; the rest stay chats.
UPDATE threads SET kind = (SELECT r.kind FROM runs r WHERE r.thread_id = threads.id
                           ORDER BY r.created_at DESC, r.id DESC LIMIT 1)
  WHERE EXISTS (SELECT 1 FROM runs r WHERE r.thread_id = threads.id);

-- Step 13: when the thread was last opened. NULL, or older than its last run's end, means its
-- result hasn't been seen.
ALTER TABLE threads ADD COLUMN seen_at INTEGER;

-- Step 15: the scheduled task this thread was made for, so every run of a task can be found.
ALTER TABLE threads ADD COLUMN schedule_id TEXT;

-- Step 17: the thread this one was handed off from ("Continue in Code", "Discuss in Chat").
ALTER TABLE threads ADD COLUMN handoff_from_id TEXT;

-- Step 16: a session's own settings. NULL means the project's default, then the app's.
ALTER TABLE threads ADD COLUMN run_mode TEXT CHECK (run_mode IN ('plan', 'ask', 'auto_edit'));
ALTER TABLE threads ADD COLUMN run_branch INTEGER CHECK (run_branch IN (0, 1));
ALTER TABLE threads ADD COLUMN run_where TEXT CHECK (run_where IN ('local', 'hulk'));
ALTER TABLE threads ADD COLUMN run_cap_micro_usd INTEGER;
