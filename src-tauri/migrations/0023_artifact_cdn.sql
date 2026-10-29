-- 0023_artifact_cdn: the per-artifact switch that lets a preview load listed CDNs (M4 step 6, AR-05).
-- See docs/data-model.md. Never edit once shipped.

ALTER TABLE artifacts ADD COLUMN allow_cdn INTEGER NOT NULL DEFAULT 0;
