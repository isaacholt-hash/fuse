-- 0033_run_summary: a long coding run's summary of its earlier steps (M6 step 9, CA-08).
-- See docs/data-model.md. Never edit once shipped.

-- When a run's history outgrows its budget, earlier steps are summarized and the loop goes on
-- from the task plus this summary; steps up to `summary_upto` (a step number) aren't sent again.
-- History stays append-only within a loop, as thinking signatures require (docs/providers.md, M6).
ALTER TABLE runs ADD COLUMN summary TEXT;
ALTER TABLE runs ADD COLUMN summary_upto INTEGER;
