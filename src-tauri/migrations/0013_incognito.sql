-- 0013_incognito: incognito chats (M2 step 5, CH-15). See docs/data-model.md.
-- Never edit once shipped.

-- Not listed, never searched, no memory; purged when you leave it (and at the next start).
ALTER TABLE threads ADD COLUMN incognito INTEGER NOT NULL DEFAULT 0 CHECK (incognito IN (0, 1));
