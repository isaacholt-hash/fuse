-- M17.2: portable version-anchored comments; reviewed writing candidates stay local/inert.
CREATE TABLE artifact_comments (
 id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id TEXT NOT NULL REFERENCES users(id), artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
 anchor_start INTEGER NOT NULL CHECK(anchor_start>=0), anchor_end INTEGER NOT NULL CHECK(anchor_end>=anchor_start),
 quote TEXT NOT NULL CHECK(length(quote)<=12000), body TEXT NOT NULL CHECK(length(body)>0 AND length(body)<=8000),
 resolved_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX artifact_comments_source ON artifact_comments(workspace_id,user_id,artifact_id,created_at,id);
CREATE TABLE artifact_proposals (
 id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id TEXT NOT NULL REFERENCES users(id), artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
 base_version_id TEXT REFERENCES artifact_versions(id) ON DELETE CASCADE,
 message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
 anchor_start INTEGER NOT NULL, anchor_end INTEGER NOT NULL,
 instruction TEXT NOT NULL CHECK(length(instruction)<=8000),
 content TEXT, state TEXT NOT NULL CHECK(state IN('requested','pending','accepted','discarded','interrupted')),
 accepted_version_id TEXT REFERENCES artifact_versions(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX artifact_proposals_source ON artifact_proposals(workspace_id,user_id,artifact_id,created_at,id);
INSERT INTO sync_reference_rules(table_name,column_name,parent_table,target,parent_has_id) VALUES
 ('artifact_comments','artifact_id','artifacts','id',0),('artifact_comments','version_id','artifact_versions','id',1);

CREATE TRIGGER sync_artifact_comments_insert AFTER INSERT ON artifact_comments
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM artifacts a JOIN threads t ON t.id=a.thread_id WHERE a.id=NEW.artifact_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_comments' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'artifact_comments',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_comments' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM artifacts a JOIN threads t ON t.id=a.thread_id WHERE a.id=NEW.artifact_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM artifacts a JOIN threads t ON t.id=a.thread_id WHERE a.id=NEW.artifact_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'artifact_id',NEW.artifact_id,'version_id',NEW.version_id,'anchor_start',NEW.anchor_start,'anchor_end',NEW.anchor_end,'quote',NEW.quote,'body',NEW.body,'resolved_at',NEW.resolved_at,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_comments' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='artifact_comments' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_comments' AND operation!='put');
 END;
CREATE TRIGGER sync_artifact_comments_update AFTER UPDATE ON artifact_comments
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM artifacts a JOIN threads t ON t.id=a.thread_id WHERE a.id=NEW.artifact_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_comments' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_comments' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.artifact_id IS NOT OLD.artifact_id OR NEW.version_id IS NOT OLD.version_id OR NEW.anchor_start IS NOT OLD.anchor_start OR NEW.anchor_end IS NOT OLD.anchor_end OR NEW.quote IS NOT OLD.quote OR NEW.body IS NOT OLD.body OR NEW.resolved_at IS NOT OLD.resolved_at OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'artifact_comments',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_comments' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM artifacts a JOIN threads t ON t.id=a.thread_id WHERE a.id=NEW.artifact_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM artifacts a JOIN threads t ON t.id=a.thread_id WHERE a.id=NEW.artifact_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'artifact_id',NEW.artifact_id,'version_id',NEW.version_id,'anchor_start',NEW.anchor_start,'anchor_end',NEW.anchor_end,'quote',NEW.quote,'body',NEW.body,'resolved_at',NEW.resolved_at,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_comments' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='artifact_comments' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_comments' AND operation!='put');
 END;
CREATE TRIGGER sync_artifact_comments_delete AFTER DELETE ON artifact_comments
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='artifact_comments' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'artifact_comments',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='artifact_comments' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'artifact_id',OLD.artifact_id,'version_id',OLD.version_id,'anchor_start',OLD.anchor_start,'anchor_end',OLD.anchor_end,'quote',OLD.quote,'body',OLD.body,'resolved_at',OLD.resolved_at,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='artifact_comments' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='artifact_comments' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='artifact_comments' AND operation!='put');
 END;
