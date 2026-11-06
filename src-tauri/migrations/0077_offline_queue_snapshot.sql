-- M18.2: the route a queued message had when it was queued (provider, model and per-million
-- prices). On reconnect a different model or price needs the owner's renewed approval.
ALTER TABLE offline_queue ADD COLUMN snapshot TEXT CHECK(snapshot IS NULL OR json_valid(snapshot));
