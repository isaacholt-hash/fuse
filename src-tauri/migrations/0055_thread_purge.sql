-- M10 step 18 (delete for real): a deleted chat keeps a tombstone row (project and kind, for
-- spend totals) once everything else is purged. purged_at tells a finished tombstone from a
-- delete still waiting on its undo window.
ALTER TABLE threads ADD COLUMN purged_at INTEGER;
