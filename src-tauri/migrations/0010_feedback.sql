-- 0010_feedback: thumbs up/down on answers (M2 step 2, CH-07). See docs/data-model.md.
-- Never edit once shipped.
ALTER TABLE messages ADD COLUMN feedback TEXT CHECK (feedback IN ('up', 'down'));
