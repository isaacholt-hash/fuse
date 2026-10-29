-- 0024_thread_stay: "stay on this provider" per chat (M4 step 10, RT-06). See docs/data-model.md.
-- Never edit once shipped.

-- 'anthropic' or 'openai': Auto picks only that provider's models in this chat (failover aside).
ALTER TABLE threads ADD COLUMN stay_provider TEXT;
