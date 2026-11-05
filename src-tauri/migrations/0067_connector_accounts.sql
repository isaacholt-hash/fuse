-- Public registration settings are installation-local. Tokens remain in the secret store.
ALTER TABLE mcp_servers ADD COLUMN builtin_kind TEXT CHECK(builtin_kind IN ('microsoft','github'));
CREATE TABLE connector_accounts (
 id TEXT PRIMARY KEY NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 client_id TEXT NOT NULL,
 tenant TEXT NOT NULL,
 services TEXT NOT NULL CHECK(json_valid(services)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TRIGGER connector_settings_audit AFTER UPDATE ON connector_accounts BEGIN
 INSERT INTO security_audit(id,workspace_id,user_id,event_kind,scope_kind,scope_id,action,created_at,updated_at)
 VALUES(lower(hex(randomblob(16))),NEW.workspace_id,NEW.user_id,'policy_change','record',NEW.id,'set',unixepoch()*1000,unixepoch()*1000);
END;
