-- 0008_routing: Auto routing (M1 step 10, RT-01, RT-09). See docs/data-model.md.
-- Never edit once shipped.

-- Per-thread pins. Both NULL = Auto; a tier pin, or a model pin (provider + model), never both.
ALTER TABLE threads ADD COLUMN pinned_tier TEXT CHECK (pinned_tier IN ('balanced', 'best'));
ALTER TABLE threads ADD COLUMN pinned_provider TEXT;
ALTER TABLE threads ADD COLUMN pinned_model TEXT;

-- How each answer's model was picked. NULL on answers from before routing.
ALTER TABLE messages ADD COLUMN pinned_mode TEXT CHECK (pinned_mode IN ('auto', 'tier', 'model'));
ALTER TABLE messages ADD COLUMN tier TEXT CHECK (tier IN ('cheap', 'balanced', 'best'));
ALTER TABLE messages ADD COLUMN route_rule_id TEXT;
ALTER TABLE messages ADD COLUMN route_reason TEXT;
-- What the classifier saw (Auto only).
ALTER TABLE messages ADD COLUMN route_intent TEXT;
ALTER TABLE messages ADD COLUMN route_complexity TEXT;
-- The same tokens priced on the cheapest Best model (RT-09); NULL when unknown.
ALTER TABLE messages ADD COLUMN best_cost_micro_usd INTEGER;

ALTER TABLE request_log ADD COLUMN tier TEXT;
ALTER TABLE request_log ADD COLUMN route_rule_id TEXT;
