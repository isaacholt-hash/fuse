-- Owner-local intent and delivery identity. Restoring or reading this table never enqueues work.
CREATE TABLE research_transfers (
 id TEXT PRIMARY KEY NOT NULL,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 source_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 target_thread_id TEXT NOT NULL,
 address TEXT NOT NULL,
 task TEXT NOT NULL,
 cap_micro_usd INTEGER NOT NULL CHECK(cap_micro_usd>0),
 setup TEXT NOT NULL CHECK(json_valid(setup)),
 input TEXT CHECK(input IS NULL OR json_valid(input)),
 state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','sent','unknown','withdrawn')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX research_transfers_source ON research_transfers(workspace_id,source_thread_id,created_at);
CREATE TRIGGER research_transfer_project_privacy AFTER UPDATE OF privacy_mode ON projects
 WHEN NEW.privacy_mode='local_only' AND NEW.privacy_mode IS NOT OLD.privacy_mode BEGIN
 UPDATE research_transfers SET input=NULL,state='withdrawn',updated_at=unixepoch()*1000
 WHERE workspace_id=NEW.workspace_id AND source_thread_id IN (SELECT id FROM threads WHERE project_id=NEW.id)
 AND state IN ('prepared','dispatched','unknown');
END;
CREATE TRIGGER research_transfer_thread_privacy AFTER UPDATE OF local_only,incognito ON threads
 WHEN NEW.local_only=1 OR NEW.incognito=1 BEGIN
 UPDATE research_transfers SET input=NULL,state='withdrawn',updated_at=unixepoch()*1000
 WHERE workspace_id=NEW.workspace_id AND source_thread_id=NEW.id AND state IN ('prepared','dispatched','unknown');
END;
