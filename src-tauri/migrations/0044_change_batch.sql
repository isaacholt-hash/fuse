-- 0044_change_batch: moves made together as one organise plan (M8 step 7, WF-06). See
-- docs/data-model.md. Never edit once shipped.
--
-- Every move in an approved plan is its own row (so each can still be shown), sharing a
-- batch_id; undoing any of them undoes the whole plan, newest first.
ALTER TABLE run_changes ADD COLUMN batch_id TEXT;
