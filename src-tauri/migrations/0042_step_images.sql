-- 0042_step_images: images a run's tool showed the model (M8 step 4, WF-03). See
-- docs/data-model.md. Never edit once shipped.
--
-- A JSON list of {"sha256", "mime"}: the bytes live in the attachment store (files/<sha256>,
-- encrypted like every attachment), so each later turn of the run can send them again.
ALTER TABLE run_steps ADD COLUMN images TEXT;
