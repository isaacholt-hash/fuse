-- M17.1: unreviewed suggestions, derived search data and content-free local tool receipts.
-- These tables are owner-local; no execution or credential authority is portable.
ALTER TABLE memory_proposals ADD COLUMN target_revision INTEGER CHECK(target_revision IS NULL OR target_revision>0);
ALTER TABLE memory_proposals ADD COLUMN thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE;
ALTER TABLE memory_proposals ADD COLUMN source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE memory_proposals ADD COLUMN source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;

CREATE TABLE artifact_vectors (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
 model TEXT NOT NULL,
 source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
 dims INTEGER NOT NULL CHECK(dims>0 AND dims<=8192),
 vector TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,user_id,version_id,model)
);

CREATE TABLE context_tool_audit (
 id TEXT PRIMARY KEY NOT NULL,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
 message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
 call_key TEXT NOT NULL,
 tool_name TEXT NOT NULL,
 record_kind TEXT NOT NULL CHECK(record_kind IN('memory','artifact')),
 record_id TEXT,
 result_id TEXT,
 outcome TEXT NOT NULL CHECK(outcome IN('read','proposed','created','updated','refused')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(workspace_id,user_id,call_key)
);
CREATE INDEX context_tool_audit_time ON context_tool_audit(workspace_id,created_at,id);

-- Derived artifact text vectors never survive withdrawal, source moves or policy changes.
CREATE TRIGGER artifact_vectors_withdraw AFTER UPDATE OF deleted_at ON artifacts WHEN NEW.deleted_at IS NOT NULL
BEGIN DELETE FROM artifact_vectors WHERE artifact_id=NEW.id; END;
CREATE TRIGGER artifact_vectors_thread_policy AFTER UPDATE OF deleted_at,incognito,local_only,project_id ON threads
WHEN NEW.deleted_at IS NOT OLD.deleted_at OR NEW.incognito IS NOT OLD.incognito OR NEW.local_only IS NOT OLD.local_only OR NEW.project_id IS NOT OLD.project_id
BEGIN DELETE FROM artifact_vectors WHERE artifact_id IN(SELECT id FROM artifacts WHERE thread_id=NEW.id); END;
CREATE TRIGGER artifact_vectors_project_policy AFTER UPDATE OF deleted_at,privacy_mode,allow_embeddings ON projects
WHEN NEW.deleted_at IS NOT OLD.deleted_at OR NEW.privacy_mode IS NOT OLD.privacy_mode OR NEW.allow_embeddings IS NOT OLD.allow_embeddings
BEGIN DELETE FROM artifact_vectors WHERE artifact_id IN(SELECT a.id FROM artifacts a JOIN threads t ON t.id=a.thread_id WHERE t.project_id=NEW.id); END;
CREATE TRIGGER artifact_vectors_egress_insert AFTER INSERT ON egress_rules
BEGIN DELETE FROM artifact_vectors WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER artifact_vectors_egress_update AFTER UPDATE ON egress_rules
BEGIN DELETE FROM artifact_vectors WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER artifact_vectors_egress_delete AFTER DELETE ON egress_rules
BEGIN DELETE FROM artifact_vectors WHERE workspace_id=OLD.workspace_id; END;
