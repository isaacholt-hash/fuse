-- 0052_run_limits: a stall watchdog for runs (M10 step 11). See docs/data-model.md.
-- Never edit once shipped.

-- Per project, beside run_mode: the cap each of its runs starts with, and the two time limits
-- in minutes. NULL means FUSE's default ($1, 120 minutes, 15 minutes without progress).
ALTER TABLE projects ADD COLUMN run_cap_micro_usd INTEGER
  CHECK (run_cap_micro_usd IS NULL OR run_cap_micro_usd > 0);
ALTER TABLE projects ADD COLUMN run_wall_minutes INTEGER
  CHECK (run_wall_minutes IS NULL OR run_wall_minutes > 0);
ALTER TABLE projects ADD COLUMN run_idle_minutes INTEGER
  CHECK (run_idle_minutes IS NULL OR run_idle_minutes > 0);

-- When the run's current leg started (set again by Continue), and the time in that leg spent
-- waiting for your answer, which counts toward neither limit. "Running for" and the wall-clock
-- limit measure now - started_at - waited_ms: the run's own work. NULL started_at: created_at.
ALTER TABLE runs ADD COLUMN started_at INTEGER;
ALTER TABLE runs ADD COLUMN waited_ms INTEGER NOT NULL DEFAULT 0;
