-- 0054_request_surface: where each request came from (M10 step 17). See docs/data-model.md.
-- Never edit once shipped.

-- 'desktop' (the app), 'web' (the web app on HULK) or 'runner' (HULK's runner: handed-over runs,
-- runs started from the web app, scheduled tasks). NULL for rows written before this: shown as
-- "Unknown". A runner row whose chat was made for a scheduled task counts as 'scheduled'.
ALTER TABLE request_log ADD COLUMN surface TEXT
  CHECK (surface IS NULL OR surface IN ('desktop', 'web', 'runner'));
