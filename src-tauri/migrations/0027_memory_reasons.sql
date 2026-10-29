-- 0027_memory_reasons: why each memory went with an answer (M5 step 6, PM-17).
-- See docs/data-model.md. Never edit once shipped.

-- always (a decision or constraint), all_fit (everything fit the budget), keyword or meaning
-- (ranked against the question; `score` is the ranking score). NULL for answers before M5.
ALTER TABLE message_memories ADD COLUMN reason TEXT
  CHECK (reason IN ('always', 'all_fit', 'keyword', 'meaning'));
ALTER TABLE message_memories ADD COLUMN score REAL;
