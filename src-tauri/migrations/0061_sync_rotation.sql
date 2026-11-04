-- Revocation remains fail-closed across a crash or a secret-store failure.
ALTER TABLE sync_state ADD COLUMN rotation_pending INTEGER NOT NULL DEFAULT 0 CHECK(rotation_pending IN(0,1));
ALTER TABLE sync_state ADD COLUMN rotation_prior_paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_state ADD COLUMN rotation_epoch INTEGER NOT NULL DEFAULT 0;
