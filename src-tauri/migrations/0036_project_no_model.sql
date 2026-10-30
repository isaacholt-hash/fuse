-- 0036_project_no_model: whether a project answers simple questions without a model (M7 step 2,
-- LL-01). See docs/data-model.md. Never edit once shipped.
--
-- Arithmetic, unit and date conversions, counting and JSON or CSV checks are answered by fixed
-- rules before routing, at $0. On by default; a project can turn it off.
ALTER TABLE projects ADD COLUMN answer_without_model INTEGER NOT NULL DEFAULT 1
  CHECK (answer_without_model IN (0, 1));
