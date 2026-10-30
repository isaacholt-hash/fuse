-- 0043_change_bytes: undo for documents a run wrote (M8 step 5, WF-04). See docs/data-model.md.
-- Never edit once shipped.
--
-- A Word, Excel or PDF file is binary, so a change to one keeps the bytes it replaced and the
-- bytes it wrote in the attachment store (encrypted, by SHA-256). `before` and `after` keep a
-- readable text version for the diff. Undo checks the file still has `after_sha`, then puts
-- `before_sha` back (or removes the file when there was none).
ALTER TABLE run_changes ADD COLUMN before_sha TEXT;
ALTER TABLE run_changes ADD COLUMN after_sha TEXT;
