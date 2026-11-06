-- M18.1: messages the owner explicitly queued while offline, on the desktop that queued them.
-- Owner-local and never synced, exported or restored as work: `origin` names the installation
-- and only it may deliver. `id` is the immutable dispatch identity, kept from queueing to send.
CREATE TABLE offline_queue (
 id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 origin TEXT NOT NULL CHECK(length(origin) BETWEEN 1 AND 100),
 text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 100000),
 effort TEXT,
 state TEXT NOT NULL CHECK(state IN('queued','dispatching','sent','cancelled','blocked','unknown')),
 reason TEXT,
 message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX offline_queue_thread ON offline_queue(workspace_id,user_id,thread_id,state,created_at,id);
-- Only normal, saved Chat may queue: never incognito, deleted or Code/Work sessions.
CREATE TRIGGER offline_queue_eligible BEFORE INSERT ON offline_queue
 WHEN NOT EXISTS(SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id
   AND t.deleted_at IS NULL AND t.incognito=0 AND t.kind='chat') BEGIN
 SELECT RAISE(ABORT,'Only a saved, non-incognito chat can queue messages.');
END;
-- A deleted chat, or one turned incognito, stops its waiting messages.
CREATE TRIGGER offline_queue_thread_closed AFTER UPDATE OF deleted_at,incognito ON threads
 WHEN NEW.deleted_at IS NOT NULL OR NEW.incognito=1 BEGIN
 UPDATE offline_queue SET state='blocked',reason='The chat was deleted or made incognito.',
   updated_at=unixepoch()*1000
 WHERE workspace_id=NEW.workspace_id AND thread_id=NEW.id AND state='queued';
END;
