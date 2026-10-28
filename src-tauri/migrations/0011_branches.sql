-- 0011_branches: edit and regenerate create branches (M2 step 3, CH-04). See docs/data-model.md.
-- Never edit once shipped.

-- The message the thread shows the path to. NULL = the newest leaf.
ALTER TABLE threads ADD COLUMN active_leaf_id TEXT REFERENCES messages(id);
