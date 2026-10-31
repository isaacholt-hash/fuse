-- 0048_step_flags: what a tool result seemed to ask for (M9 step 4, AG-10). See
-- docs/data-model.md. Never edit once shipped.
--
-- JSON, a list of {why, passage}, on the tool step whose output had them; null when none. Once a
-- run has a flagged step, its later writes, commands and sends ask, show the passages, and can't
-- be always-allowed.
ALTER TABLE run_steps ADD COLUMN flags TEXT;
