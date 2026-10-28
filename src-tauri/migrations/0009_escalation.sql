-- 0009_escalation: "Try a stronger model" (M1 step 11, RT-04). See docs/data-model.md.
-- Never edit once shipped.

-- The answer this one re-ran one tier up. Both stay in the thread; later turns send only the newer.
ALTER TABLE messages ADD COLUMN escalated_from_id TEXT REFERENCES messages(id);
