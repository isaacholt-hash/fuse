-- 0034_run_branch: the branch a coding run works on, when it made its own (M6 step 10, CA-05).
-- See docs/data-model.md. Never edit once shipped.
ALTER TABLE runs ADD COLUMN branch TEXT;
