-- 0035_run_plan: the plan a stronger model wrote before a coding run's loop (M6 step 11, CA-07,
-- RT-14). See docs/data-model.md. Never edit once shipped.
--
-- With Auto routing, the cheapest Best model plans in a request of its own (no tools), and the
-- routed model works through the task with that plan: a tool loop stays on one model.
ALTER TABLE runs ADD COLUMN plan TEXT;
-- "provider/model" of the planner.
ALTER TABLE runs ADD COLUMN planner TEXT;
