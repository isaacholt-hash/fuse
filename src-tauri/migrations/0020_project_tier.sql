-- 0020_project_tier: a project's default can be a tier (M3 step 2, PM-01, RT-01).
-- See docs/data-model.md. Never edit once shipped.

-- New chats in the project start pinned to this tier. A default model (default_provider,
-- default_model) wins if both are set; both NULL means Auto.
ALTER TABLE projects ADD COLUMN default_tier TEXT CHECK (default_tier IN ('balanced', 'best'));
