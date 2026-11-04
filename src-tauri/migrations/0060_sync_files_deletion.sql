ALTER TABLE threads ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0 CHECK(local_only IN (0,1));
ALTER TABLE prompts ADD COLUMN sync_local_only INTEGER NOT NULL DEFAULT 0 CHECK(sync_local_only IN (0,1));
-- M11 step 6. All content in these tables is protected by the local SQLCipher database.
CREATE TABLE sync_entities (
 workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,table_name TEXT NOT NULL,
 original_id TEXT NOT NULL,record_key TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,table_name,original_id)
);
CREATE TABLE sync_lineage (
 workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,table_name TEXT NOT NULL,record_key TEXT NOT NULL,
 column_name TEXT NOT NULL,parent_table TEXT NOT NULL,parent_id TEXT NOT NULL,parent_key TEXT,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,table_name,record_key,column_name)
);
CREATE TABLE sync_prepared (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,
 event TEXT NOT NULL,record_manifest TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TABLE sync_transfers (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,event_id TEXT NOT NULL,
 direction TEXT NOT NULL,sha256 TEXT NOT NULL,total_bytes INTEGER NOT NULL,
 manifest TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0,bytes_done INTEGER NOT NULL DEFAULT 0,verified INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TABLE sync_blob_refs (
 workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,event_id TEXT NOT NULL,blob_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,event_id,blob_id)
);
CREATE TABLE sync_seen (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,
 digest TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TABLE sync_unavailable (
 workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,table_name TEXT NOT NULL,record_key TEXT NOT NULL,
 column_name TEXT NOT NULL,parent_table TEXT NOT NULL,parent_id TEXT NOT NULL,reason TEXT NOT NULL,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,table_name,record_key,column_name)
);
CREATE TABLE sync_releases (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
ALTER TABLE sync_relay ADD COLUMN table_name TEXT;
ALTER TABLE sync_relay ADD COLUMN record_key TEXT;
ALTER TABLE sync_relay ADD COLUMN operation TEXT;
ALTER TABLE sync_relay ADD COLUMN version TEXT;
CREATE INDEX sync_relay_entity ON sync_relay(workspace_id,table_name,record_key);

ALTER TABLE sync_tombstones ADD COLUMN scope TEXT NOT NULL DEFAULT 'record';
ALTER TABLE sync_outbox ADD COLUMN barriers TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sync_records ADD COLUMN barriers TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sync_state ADD COLUMN wipe_version TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sync_outbox ADD COLUMN wire_format INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sync_records ADD COLUMN wire_format INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER sync_capture_format AFTER INSERT ON sync_outbox BEGIN
 UPDATE sync_outbox SET wire_format=2 WHERE id=NEW.id;
END;
CREATE TRIGGER sync_record_format_insert AFTER INSERT ON sync_records
 WHEN (SELECT applying FROM sync_state WHERE workspace_id=NEW.workspace_id)=0 BEGIN
 UPDATE sync_records SET wire_format=2,barriers=COALESCE((SELECT barriers FROM sync_outbox WHERE id=NEW.event_id),'{}') WHERE workspace_id=NEW.workspace_id AND table_name=NEW.table_name AND record_key=NEW.record_key;
END;
CREATE TRIGGER sync_record_format_update AFTER UPDATE OF event_id ON sync_records
 WHEN (SELECT applying FROM sync_state WHERE workspace_id=NEW.workspace_id)=0 BEGIN
 UPDATE sync_records SET wire_format=2,barriers=COALESCE((SELECT barriers FROM sync_outbox WHERE id=NEW.event_id),'{}') WHERE workspace_id=NEW.workspace_id AND table_name=NEW.table_name AND record_key=NEW.record_key;
END;

CREATE TABLE sync_reference_rules (
 workspace_id TEXT NOT NULL DEFAULT '00000000-0000-7000-8000-000000000001',user_id TEXT NOT NULL DEFAULT '00000000-0000-7000-8000-000000000002',
 table_name TEXT NOT NULL,column_name TEXT NOT NULL,parent_table TEXT NOT NULL,target TEXT NOT NULL,parent_has_id INTEGER NOT NULL,created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(table_name,column_name)
);
INSERT INTO sync_reference_rules(table_name,column_name,parent_table,target,parent_has_id) VALUES
('threads','active_leaf_id','messages','id',1),
('threads','project_id','projects','id',1),
('messages','escalated_from_id','messages','id',1),
('messages','parent_id','messages','id',1),
('messages','request_id','request_log','id',1),
('messages','thread_id','threads','id',1),
('message_citations','message_id','messages','id',1),
('message_files','file_id','files','id',1),
('message_files','message_id','messages','id',1),
('files','thread_id','threads','id',1),
('thread_summaries','thread_id','threads','id',1),
('thread_summaries','upto_message_id','messages','id',1),
('memories','project_id','projects','id',1),
('memories','source_artifact_id','artifacts','id',0),
('memories','source_message_id','messages','id',1),
('memories','source_thread_id','threads','id',1),
('memories','superseded_by_id','memories','id',1),
('memories','thread_id','threads','id',1),
('message_memories','memory_id','memories','id',1),
('message_memories','message_id','messages','id',1),
('artifacts','thread_id','threads','id',1),
('artifact_versions','artifact_id','artifacts','id',0),
('artifact_versions','message_id','messages','id',1),
('budgets','project_id','projects','id',1),
('web_pages','file_id','files','id',1),
('imports','thread_id','threads','id',1),
('thread_tags','thread_id','threads','id',1),
('prompts','project_id','projects','id',1),
('egress_rules','project_id','projects','id',1),
('request_log','thread_id','threads','id',1),
('runs','message_id','messages','id',1),
('runs','project_id','projects','id',1),
('runs','thread_id','threads','id',1),
('run_steps','request_id','request_log','id',1),
('run_steps','run_id','runs','id',1),
('run_changes','run_id','runs','id',1),
('run_changes','step_id','run_steps','id',1),
('project_files','file_id','files','id',1),
('project_files','project_id','projects','id',1);
CREATE TRIGGER sync_capture_lineage AFTER INSERT ON sync_outbox WHEN NEW.operation='put' BEGIN
 INSERT INTO sync_entities(workspace_id,user_id,table_name,original_id,record_key,created_at,updated_at)
 SELECT NEW.workspace_id,NEW.user_id,NEW.table_name,json_extract(NEW.payload,'$.id'),NEW.record_key,NEW.created_at,NEW.updated_at WHERE json_extract(NEW.payload,'$.id') IS NOT NULL
 ON CONFLICT(workspace_id,table_name,original_id) DO UPDATE SET record_key=excluded.record_key,updated_at=excluded.updated_at;
 DELETE FROM sync_lineage WHERE workspace_id=NEW.workspace_id AND table_name=NEW.table_name AND record_key=NEW.record_key;
 INSERT INTO sync_lineage(workspace_id,user_id,table_name,record_key,column_name,parent_table,parent_id,parent_key,created_at,updated_at)
 SELECT NEW.workspace_id,NEW.user_id,NEW.table_name,NEW.record_key,r.column_name,r.parent_table,j.value,COALESCE(e.record_key,CASE WHEN r.parent_has_id=1 THEN j.value END),NEW.created_at,NEW.updated_at
 FROM sync_reference_rules r JOIN json_each(NEW.payload) j ON j.key=r.column_name LEFT JOIN sync_entities e ON e.workspace_id=NEW.workspace_id AND e.table_name=r.parent_table AND e.original_id=j.value
 WHERE r.table_name=NEW.table_name AND j.type='text';
END;

CREATE TRIGGER sync_capture_marker AFTER INSERT ON sync_outbox WHEN NEW.operation!='put' BEGIN
 INSERT INTO sync_tombstones(workspace_id,user_id,table_name,record_key,event_id,operation,version,scope,created_at,updated_at)
 VALUES(NEW.workspace_id,NEW.user_id,NEW.table_name,NEW.record_key,NEW.id,NEW.operation,NEW.version,CASE WHEN NEW.table_name='projects' AND NEW.operation='delete' AND EXISTS(SELECT 1 FROM projects WHERE id=NEW.record_key AND deleted_at IS NOT NULL) THEN 'archive' ELSE 'record' END,NEW.created_at,NEW.updated_at)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET event_id=excluded.event_id,operation=excluded.operation,version=excluded.version,scope=excluded.scope,updated_at=excluded.updated_at;
END;
-- Once enrolled, disabling pauses transfers while retaining later changes for explicit re-enable.
-- A never-enrolled installation (epoch=0) still captures nothing.
DROP TRIGGER sync_projects_insert;
CREATE TRIGGER sync_projects_insert AFTER INSERT ON projects
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((NEW.privacy_mode!='local_only') OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='projects' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'projects',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='projects' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (NEW.privacy_mode!='local_only') THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (NEW.privacy_mode!='local_only') THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'name',NEW.name,'instructions',NEW.instructions,'default_provider',NEW.default_provider,'default_model',NEW.default_model,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at,'default_tier',NEW.default_tier,'privacy_mode',NEW.privacy_mode,'allow_embeddings',NEW.allow_embeddings,'answer_without_model',NEW.answer_without_model,'run_cap_micro_usd',NEW.run_cap_micro_usd,'run_wall_minutes',NEW.run_wall_minutes,'run_idle_minutes',NEW.run_idle_minutes) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='projects' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='projects' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='projects' AND operation!='put');
 END;
DROP TRIGGER sync_projects_update;
CREATE TRIGGER sync_projects_update AFTER UPDATE ON projects
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((NEW.privacy_mode!='local_only') OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='projects' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='projects' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.name IS NOT OLD.name OR NEW.instructions IS NOT OLD.instructions OR NEW.default_provider IS NOT OLD.default_provider OR NEW.default_model IS NOT OLD.default_model OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.default_tier IS NOT OLD.default_tier OR NEW.privacy_mode IS NOT OLD.privacy_mode OR NEW.allow_embeddings IS NOT OLD.allow_embeddings OR NEW.answer_without_model IS NOT OLD.answer_without_model OR NEW.run_cap_micro_usd IS NOT OLD.run_cap_micro_usd OR NEW.run_wall_minutes IS NOT OLD.run_wall_minutes OR NEW.run_idle_minutes IS NOT OLD.run_idle_minutes))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'projects',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='projects' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (NEW.privacy_mode!='local_only') THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (NEW.privacy_mode!='local_only') THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'name',NEW.name,'instructions',NEW.instructions,'default_provider',NEW.default_provider,'default_model',NEW.default_model,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at,'default_tier',NEW.default_tier,'privacy_mode',NEW.privacy_mode,'allow_embeddings',NEW.allow_embeddings,'answer_without_model',NEW.answer_without_model,'run_cap_micro_usd',NEW.run_cap_micro_usd,'run_wall_minutes',NEW.run_wall_minutes,'run_idle_minutes',NEW.run_idle_minutes) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='projects' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='projects' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='projects' AND operation!='put');
 END;
DROP TRIGGER sync_projects_delete;
CREATE TRIGGER sync_projects_delete AFTER DELETE ON projects
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='projects' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'projects',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='projects' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'name',OLD.name,'instructions',OLD.instructions,'default_provider',OLD.default_provider,'default_model',OLD.default_model,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'deleted_at',OLD.deleted_at,'default_tier',OLD.default_tier,'privacy_mode',OLD.privacy_mode,'allow_embeddings',OLD.allow_embeddings,'answer_without_model',OLD.answer_without_model,'run_cap_micro_usd',OLD.run_cap_micro_usd,'run_wall_minutes',OLD.run_wall_minutes,'run_idle_minutes',OLD.run_idle_minutes) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='projects' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='projects' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='projects' AND operation!='put');
 END;
DROP TRIGGER sync_threads_insert;
CREATE TRIGGER sync_threads_insert AFTER INSERT ON threads
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (((NEW.deleted_at IS NULL OR NEW.purged_at IS NOT NULL)) AND ((NEW.incognito=0 AND NEW.local_only=0 AND ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='threads' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'threads',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='threads' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (NEW.incognito=0 AND NEW.local_only=0 AND ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' WHEN NEW.purged_at IS NOT NULL THEN 'delete' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (NEW.incognito=0 AND NEW.local_only=0 AND ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' WHEN NEW.purged_at IS NOT NULL THEN 'delete' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'title',NEW.title,'title_source',NEW.title_source,'last_message_at',NEW.last_message_at,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at,'web_search',NEW.web_search,'instructions',NEW.instructions,'project_id',NEW.project_id,'memory_injection',NEW.memory_injection,'memory_checked_at',NEW.memory_checked_at,'pinned_tier',NEW.pinned_tier,'pinned_provider',NEW.pinned_provider,'pinned_model',NEW.pinned_model,'active_leaf_id',NEW.active_leaf_id,'incognito',NEW.incognito,'pinned_at',NEW.pinned_at,'archived_at',NEW.archived_at,'stay_provider',NEW.stay_provider,'kind',NEW.kind,'handoff_from_id',NEW.handoff_from_id,'run_cap_micro_usd',NEW.run_cap_micro_usd,'schedule_id',NEW.schedule_id,'purged_at',NEW.purged_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='threads' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='threads' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='threads' AND operation!='put');
 END;
DROP TRIGGER sync_threads_update;
CREATE TRIGGER sync_threads_update AFTER UPDATE ON threads
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (((NEW.deleted_at IS NULL OR NEW.purged_at IS NOT NULL)) AND ((NEW.incognito=0 AND NEW.local_only=0 AND ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='threads' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='threads' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.title IS NOT OLD.title OR NEW.title_source IS NOT OLD.title_source OR NEW.last_message_at IS NOT OLD.last_message_at OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.web_search IS NOT OLD.web_search OR NEW.instructions IS NOT OLD.instructions OR NEW.project_id IS NOT OLD.project_id OR NEW.memory_injection IS NOT OLD.memory_injection OR NEW.memory_checked_at IS NOT OLD.memory_checked_at OR NEW.pinned_tier IS NOT OLD.pinned_tier OR NEW.pinned_provider IS NOT OLD.pinned_provider OR NEW.pinned_model IS NOT OLD.pinned_model OR NEW.active_leaf_id IS NOT OLD.active_leaf_id OR NEW.incognito IS NOT OLD.incognito OR NEW.pinned_at IS NOT OLD.pinned_at OR NEW.archived_at IS NOT OLD.archived_at OR NEW.stay_provider IS NOT OLD.stay_provider OR NEW.kind IS NOT OLD.kind OR NEW.handoff_from_id IS NOT OLD.handoff_from_id OR NEW.run_cap_micro_usd IS NOT OLD.run_cap_micro_usd OR NEW.purged_at IS NOT OLD.purged_at OR NEW.schedule_id IS NOT OLD.schedule_id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'threads',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='threads' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (NEW.incognito=0 AND NEW.local_only=0 AND ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' WHEN NEW.purged_at IS NOT NULL THEN 'delete' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (NEW.incognito=0 AND NEW.local_only=0 AND ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' WHEN NEW.purged_at IS NOT NULL THEN 'delete' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'title',NEW.title,'title_source',NEW.title_source,'last_message_at',NEW.last_message_at,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at,'web_search',NEW.web_search,'instructions',NEW.instructions,'project_id',NEW.project_id,'memory_injection',NEW.memory_injection,'memory_checked_at',NEW.memory_checked_at,'pinned_tier',NEW.pinned_tier,'pinned_provider',NEW.pinned_provider,'pinned_model',NEW.pinned_model,'active_leaf_id',NEW.active_leaf_id,'incognito',NEW.incognito,'pinned_at',NEW.pinned_at,'archived_at',NEW.archived_at,'stay_provider',NEW.stay_provider,'kind',NEW.kind,'handoff_from_id',NEW.handoff_from_id,'run_cap_micro_usd',NEW.run_cap_micro_usd,'schedule_id',NEW.schedule_id,'purged_at',NEW.purged_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='threads' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='threads' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='threads' AND operation!='put');
 END;
DROP TRIGGER sync_threads_delete;
CREATE TRIGGER sync_threads_delete AFTER DELETE ON threads
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='threads' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'threads',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='threads' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'title',OLD.title,'title_source',OLD.title_source,'last_message_at',OLD.last_message_at,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'deleted_at',OLD.deleted_at,'web_search',OLD.web_search,'instructions',OLD.instructions,'project_id',OLD.project_id,'memory_injection',OLD.memory_injection,'memory_checked_at',OLD.memory_checked_at,'pinned_tier',OLD.pinned_tier,'pinned_provider',OLD.pinned_provider,'pinned_model',OLD.pinned_model,'active_leaf_id',OLD.active_leaf_id,'incognito',OLD.incognito,'pinned_at',OLD.pinned_at,'archived_at',OLD.archived_at,'stay_provider',OLD.stay_provider,'kind',OLD.kind,'handoff_from_id',OLD.handoff_from_id,'run_cap_micro_usd',OLD.run_cap_micro_usd,'purged_at',OLD.purged_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='threads' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='threads' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='threads' AND operation!='put');
 END;
DROP TRIGGER sync_messages_insert;
CREATE TRIGGER sync_messages_insert AFTER INSERT ON messages
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((NEW.status!='streaming' AND NEW.deleted_at IS NULL) AND (((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='messages' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'messages',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='messages' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'thread_id',NEW.thread_id,'parent_id',NEW.parent_id,'role',NEW.role,'content',NEW.content,'status',NEW.status,'error_code',NEW.error_code,'error_message',NEW.error_message,'provider',NEW.provider,'model',NEW.model,'input_tokens',NEW.input_tokens,'output_tokens',NEW.output_tokens,'cached_input_tokens',NEW.cached_input_tokens,'cache_write_tokens',NEW.cache_write_tokens,'reasoning_tokens',NEW.reasoning_tokens,'cost_micro_usd',NEW.cost_micro_usd,'price_version',NEW.price_version,'latency_ms',NEW.latency_ms,'ttft_ms',NEW.ttft_ms,'request_id',NEW.request_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at,'web_search_calls',NEW.web_search_calls,'pinned_mode',NEW.pinned_mode,'tier',NEW.tier,'route_rule_id',NEW.route_rule_id,'route_reason',NEW.route_reason,'route_intent',NEW.route_intent,'route_complexity',NEW.route_complexity,'best_cost_micro_usd',NEW.best_cost_micro_usd,'escalated_from_id',NEW.escalated_from_id,'feedback',NEW.feedback,'reasoning_summary',NEW.reasoning_summary) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='messages' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='messages' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='messages' AND operation!='put');
 END;
DROP TRIGGER sync_messages_update;
CREATE TRIGGER sync_messages_update AFTER UPDATE ON messages
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((NEW.status!='streaming' AND NEW.deleted_at IS NULL) AND (((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='messages' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='messages' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.parent_id IS NOT OLD.parent_id OR NEW.role IS NOT OLD.role OR NEW.content IS NOT OLD.content OR NEW.status IS NOT OLD.status OR NEW.error_code IS NOT OLD.error_code OR NEW.error_message IS NOT OLD.error_message OR NEW.provider IS NOT OLD.provider OR NEW.model IS NOT OLD.model OR NEW.input_tokens IS NOT OLD.input_tokens OR NEW.output_tokens IS NOT OLD.output_tokens OR NEW.cached_input_tokens IS NOT OLD.cached_input_tokens OR NEW.cache_write_tokens IS NOT OLD.cache_write_tokens OR NEW.reasoning_tokens IS NOT OLD.reasoning_tokens OR NEW.cost_micro_usd IS NOT OLD.cost_micro_usd OR NEW.price_version IS NOT OLD.price_version OR NEW.latency_ms IS NOT OLD.latency_ms OR NEW.ttft_ms IS NOT OLD.ttft_ms OR NEW.request_id IS NOT OLD.request_id OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.web_search_calls IS NOT OLD.web_search_calls OR NEW.pinned_mode IS NOT OLD.pinned_mode OR NEW.tier IS NOT OLD.tier OR NEW.route_rule_id IS NOT OLD.route_rule_id OR NEW.route_reason IS NOT OLD.route_reason OR NEW.route_intent IS NOT OLD.route_intent OR NEW.route_complexity IS NOT OLD.route_complexity OR NEW.best_cost_micro_usd IS NOT OLD.best_cost_micro_usd OR NEW.escalated_from_id IS NOT OLD.escalated_from_id OR NEW.feedback IS NOT OLD.feedback OR NEW.reasoning_summary IS NOT OLD.reasoning_summary))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'messages',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='messages' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'thread_id',NEW.thread_id,'parent_id',NEW.parent_id,'role',NEW.role,'content',NEW.content,'status',NEW.status,'error_code',NEW.error_code,'error_message',NEW.error_message,'provider',NEW.provider,'model',NEW.model,'input_tokens',NEW.input_tokens,'output_tokens',NEW.output_tokens,'cached_input_tokens',NEW.cached_input_tokens,'cache_write_tokens',NEW.cache_write_tokens,'reasoning_tokens',NEW.reasoning_tokens,'cost_micro_usd',NEW.cost_micro_usd,'price_version',NEW.price_version,'latency_ms',NEW.latency_ms,'ttft_ms',NEW.ttft_ms,'request_id',NEW.request_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at,'web_search_calls',NEW.web_search_calls,'pinned_mode',NEW.pinned_mode,'tier',NEW.tier,'route_rule_id',NEW.route_rule_id,'route_reason',NEW.route_reason,'route_intent',NEW.route_intent,'route_complexity',NEW.route_complexity,'best_cost_micro_usd',NEW.best_cost_micro_usd,'escalated_from_id',NEW.escalated_from_id,'feedback',NEW.feedback,'reasoning_summary',NEW.reasoning_summary) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='messages' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='messages' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='messages' AND operation!='put');
 END;
DROP TRIGGER sync_messages_delete;
CREATE TRIGGER sync_messages_delete AFTER DELETE ON messages
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='messages' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'messages',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='messages' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'thread_id',OLD.thread_id,'parent_id',OLD.parent_id,'role',OLD.role,'content',OLD.content,'status',OLD.status,'error_code',OLD.error_code,'error_message',OLD.error_message,'provider',OLD.provider,'model',OLD.model,'input_tokens',OLD.input_tokens,'output_tokens',OLD.output_tokens,'cached_input_tokens',OLD.cached_input_tokens,'cache_write_tokens',OLD.cache_write_tokens,'reasoning_tokens',OLD.reasoning_tokens,'cost_micro_usd',OLD.cost_micro_usd,'price_version',OLD.price_version,'latency_ms',OLD.latency_ms,'ttft_ms',OLD.ttft_ms,'request_id',OLD.request_id,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'deleted_at',OLD.deleted_at,'web_search_calls',OLD.web_search_calls,'pinned_mode',OLD.pinned_mode,'tier',OLD.tier,'route_rule_id',OLD.route_rule_id,'route_reason',OLD.route_reason,'route_intent',OLD.route_intent,'route_complexity',OLD.route_complexity,'best_cost_micro_usd',OLD.best_cost_micro_usd,'escalated_from_id',OLD.escalated_from_id,'feedback',OLD.feedback,'reasoning_summary',OLD.reasoning_summary) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='messages' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='messages' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='messages' AND operation!='put');
 END;
DROP TRIGGER sync_message_citations_insert;
CREATE TRIGGER sync_message_citations_insert AFTER INSERT ON message_citations
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_citations' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'message_citations',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_citations' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'message_id',NEW.message_id,'ordinal',NEW.ordinal,'kind',NEW.kind,'url',NEW.url,'title',NEW.title,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_citations' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='message_citations' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_citations' AND operation!='put');
 END;
DROP TRIGGER sync_message_citations_update;
CREATE TRIGGER sync_message_citations_update AFTER UPDATE ON message_citations
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_citations' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_citations' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.message_id IS NOT OLD.message_id OR NEW.ordinal IS NOT OLD.ordinal OR NEW.kind IS NOT OLD.kind OR NEW.url IS NOT OLD.url OR NEW.title IS NOT OLD.title OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'message_citations',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_citations' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'message_id',NEW.message_id,'ordinal',NEW.ordinal,'kind',NEW.kind,'url',NEW.url,'title',NEW.title,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_citations' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='message_citations' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_citations' AND operation!='put');
 END;
DROP TRIGGER sync_message_citations_delete;
CREATE TRIGGER sync_message_citations_delete AFTER DELETE ON message_citations
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='message_citations' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'message_citations',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='message_citations' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'message_id',OLD.message_id,'ordinal',OLD.ordinal,'kind',OLD.kind,'url',OLD.url,'title',OLD.title,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='message_citations' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='message_citations' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='message_citations' AND operation!='put');
 END;
DROP TRIGGER sync_message_files_insert;
CREATE TRIGGER sync_message_files_insert AFTER INSERT ON message_files
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) AND EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id) AND NOT EXISTS (SELECT 1 FROM files f JOIN projects p ON p.id=f.project_id WHERE f.id=NEW.file_id AND p.privacy_mode='local_only')) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_files' AND record_key=json_array(NEW.message_id,NEW.file_id,NEW.ordinal))))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'message_files',json_array(NEW.message_id,NEW.file_id,NEW.ordinal),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_files' AND record_key=json_array(NEW.message_id,NEW.file_id,NEW.ordinal)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) AND EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id) AND NOT EXISTS (SELECT 1 FROM files f JOIN projects p ON p.id=f.project_id WHERE f.id=NEW.file_id AND p.privacy_mode='local_only')) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) AND EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id) AND NOT EXISTS (SELECT 1 FROM files f JOIN projects p ON p.id=f.project_id WHERE f.id=NEW.file_id AND p.privacy_mode='local_only')) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'message_id',NEW.message_id,'file_id',NEW.file_id,'ordinal',NEW.ordinal,'mode',NEW.mode,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_files' AND record_key=json_array(NEW.message_id,NEW.file_id,NEW.ordinal)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='message_files' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_files' AND operation!='put');
 END;
DROP TRIGGER sync_message_files_update;
CREATE TRIGGER sync_message_files_update AFTER UPDATE ON message_files
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) AND EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id) AND NOT EXISTS (SELECT 1 FROM files f JOIN projects p ON p.id=f.project_id WHERE f.id=NEW.file_id AND p.privacy_mode='local_only')) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_files' AND record_key=json_array(NEW.message_id,NEW.file_id,NEW.ordinal)))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_files' AND record_key=json_array(NEW.message_id,NEW.file_id,NEW.ordinal)) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.message_id IS NOT OLD.message_id OR NEW.file_id IS NOT OLD.file_id OR NEW.ordinal IS NOT OLD.ordinal OR NEW.mode IS NOT OLD.mode OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'message_files',json_array(NEW.message_id,NEW.file_id,NEW.ordinal),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_files' AND record_key=json_array(NEW.message_id,NEW.file_id,NEW.ordinal)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) AND EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id) AND NOT EXISTS (SELECT 1 FROM files f JOIN projects p ON p.id=f.project_id WHERE f.id=NEW.file_id AND p.privacy_mode='local_only')) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) AND EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id) AND NOT EXISTS (SELECT 1 FROM files f JOIN projects p ON p.id=f.project_id WHERE f.id=NEW.file_id AND p.privacy_mode='local_only')) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'message_id',NEW.message_id,'file_id',NEW.file_id,'ordinal',NEW.ordinal,'mode',NEW.mode,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_files' AND record_key=json_array(NEW.message_id,NEW.file_id,NEW.ordinal)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='message_files' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_files' AND operation!='put');
 END;
DROP TRIGGER sync_message_files_delete;
CREATE TRIGGER sync_message_files_delete AFTER DELETE ON message_files
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='message_files' AND record_key=json_array(OLD.message_id,OLD.file_id,OLD.ordinal)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'message_files',json_array(OLD.message_id,OLD.file_id,OLD.ordinal),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='message_files' AND record_key=json_array(OLD.message_id,OLD.file_id,OLD.ordinal)),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'message_id',OLD.message_id,'file_id',OLD.file_id,'ordinal',OLD.ordinal,'mode',OLD.mode,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='message_files' AND record_key=json_array(OLD.message_id,OLD.file_id,OLD.ordinal)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='message_files' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='message_files' AND operation!='put');
 END;
DROP TRIGGER sync_files_insert;
CREATE TRIGGER sync_files_insert AFTER INSERT ON files
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((NEW.may_send=1 AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.id) AND ((NEW.thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM message_files mf JOIN messages m ON m.id=mf.message_id JOIN threads t ON t.id=m.thread_id WHERE mf.file_id=NEW.id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM project_files pf JOIN projects p ON p.id=pf.project_id WHERE pf.file_id=NEW.id AND pf.deleted_at IS NULL AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='files' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'files',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='files' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (NEW.may_send=1 AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.id) AND ((NEW.thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM message_files mf JOIN messages m ON m.id=mf.message_id JOIN threads t ON t.id=m.thread_id WHERE mf.file_id=NEW.id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM project_files pf JOIN projects p ON p.id=pf.project_id WHERE pf.file_id=NEW.id AND pf.deleted_at IS NULL AND p.privacy_mode!='local_only'))) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (NEW.may_send=1 AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.id) AND ((NEW.thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM message_files mf JOIN messages m ON m.id=mf.message_id JOIN threads t ON t.id=m.thread_id WHERE mf.file_id=NEW.id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM project_files pf JOIN projects p ON p.id=pf.project_id WHERE pf.file_id=NEW.id AND pf.deleted_at IS NULL AND p.privacy_mode!='local_only'))) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'name',NEW.name,'mime',NEW.mime,'size_bytes',NEW.size_bytes,'sha256',NEW.sha256,'width',NEW.width,'height',NEW.height,'token_estimate',NEW.token_estimate,'parse_status',NEW.parse_status,'parse_error',NEW.parse_error,'project_id',NEW.project_id,'thread_id',NEW.thread_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at,'may_send',NEW.may_send) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='files' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='files' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='files' AND operation!='put');
 END;
DROP TRIGGER sync_files_update;
CREATE TRIGGER sync_files_update AFTER UPDATE ON files
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((NEW.may_send=1 AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.id) AND ((NEW.thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM message_files mf JOIN messages m ON m.id=mf.message_id JOIN threads t ON t.id=m.thread_id WHERE mf.file_id=NEW.id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM project_files pf JOIN projects p ON p.id=pf.project_id WHERE pf.file_id=NEW.id AND pf.deleted_at IS NULL AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='files' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='files' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.name IS NOT OLD.name OR NEW.mime IS NOT OLD.mime OR NEW.size_bytes IS NOT OLD.size_bytes OR NEW.sha256 IS NOT OLD.sha256 OR NEW.width IS NOT OLD.width OR NEW.height IS NOT OLD.height OR NEW.token_estimate IS NOT OLD.token_estimate OR NEW.parse_status IS NOT OLD.parse_status OR NEW.parse_error IS NOT OLD.parse_error OR NEW.project_id IS NOT OLD.project_id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.may_send IS NOT OLD.may_send))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'files',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='files' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (NEW.may_send=1 AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.id) AND ((NEW.thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM message_files mf JOIN messages m ON m.id=mf.message_id JOIN threads t ON t.id=m.thread_id WHERE mf.file_id=NEW.id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM project_files pf JOIN projects p ON p.id=pf.project_id WHERE pf.file_id=NEW.id AND pf.deleted_at IS NULL AND p.privacy_mode!='local_only'))) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (NEW.may_send=1 AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.id) AND ((NEW.thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM message_files mf JOIN messages m ON m.id=mf.message_id JOIN threads t ON t.id=m.thread_id WHERE mf.file_id=NEW.id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM project_files pf JOIN projects p ON p.id=pf.project_id WHERE pf.file_id=NEW.id AND pf.deleted_at IS NULL AND p.privacy_mode!='local_only'))) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'name',NEW.name,'mime',NEW.mime,'size_bytes',NEW.size_bytes,'sha256',NEW.sha256,'width',NEW.width,'height',NEW.height,'token_estimate',NEW.token_estimate,'parse_status',NEW.parse_status,'parse_error',NEW.parse_error,'project_id',NEW.project_id,'thread_id',NEW.thread_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at,'may_send',NEW.may_send) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='files' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='files' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='files' AND operation!='put');
 END;
DROP TRIGGER sync_files_delete;
CREATE TRIGGER sync_files_delete AFTER DELETE ON files
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='files' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'files',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='files' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'name',OLD.name,'mime',OLD.mime,'size_bytes',OLD.size_bytes,'sha256',OLD.sha256,'width',OLD.width,'height',OLD.height,'token_estimate',OLD.token_estimate,'parse_status',OLD.parse_status,'parse_error',OLD.parse_error,'project_id',OLD.project_id,'thread_id',OLD.thread_id,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'deleted_at',OLD.deleted_at,'may_send',OLD.may_send) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='files' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='files' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='files' AND operation!='put');
 END;
DROP TRIGGER sync_thread_summaries_insert;
CREATE TRIGGER sync_thread_summaries_insert AFTER INSERT ON thread_summaries
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_summaries' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'thread_summaries',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_summaries' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'thread_id',NEW.thread_id,'upto_message_id',NEW.upto_message_id,'summary',NEW.summary,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_summaries' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='thread_summaries' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_summaries' AND operation!='put');
 END;
DROP TRIGGER sync_thread_summaries_update;
CREATE TRIGGER sync_thread_summaries_update AFTER UPDATE ON thread_summaries
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_summaries' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_summaries' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.upto_message_id IS NOT OLD.upto_message_id OR NEW.summary IS NOT OLD.summary OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'thread_summaries',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_summaries' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'thread_id',NEW.thread_id,'upto_message_id',NEW.upto_message_id,'summary',NEW.summary,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_summaries' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='thread_summaries' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_summaries' AND operation!='put');
 END;
DROP TRIGGER sync_thread_summaries_delete;
CREATE TRIGGER sync_thread_summaries_delete AFTER DELETE ON thread_summaries
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='thread_summaries' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'thread_summaries',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='thread_summaries' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'thread_id',OLD.thread_id,'upto_message_id',OLD.upto_message_id,'summary',OLD.summary,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='thread_summaries' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='thread_summaries' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='thread_summaries' AND operation!='put');
 END;
DROP TRIGGER sync_memories_insert;
CREATE TRIGGER sync_memories_insert AFTER INSERT ON memories
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) AND NEW.may_send=1) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='memories' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'memories',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='memories' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) AND NEW.may_send=1) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) AND NEW.may_send=1) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'text',NEW.text,'kind',NEW.kind,'scope',NEW.scope,'project_id',NEW.project_id,'thread_id',NEW.thread_id,'authority',NEW.authority,'source_thread_id',NEW.source_thread_id,'source_message_id',NEW.source_message_id,'source_artifact_id',NEW.source_artifact_id,'extraction_method',NEW.extraction_method,'extraction_model',NEW.extraction_model,'confidence',NEW.confidence,'last_verified_at',NEW.last_verified_at,'expires_at',NEW.expires_at,'status',NEW.status,'sensitivity',NEW.sensitivity,'may_send',NEW.may_send,'superseded_by_id',NEW.superseded_by_id,'rationale',NEW.rationale,'alternatives',NEW.alternatives,'task_status',NEW.task_status,'depends_on',NEW.depends_on,'revision',MAX(NEW.revision,COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='memories' AND record_key=NEW.id),0)+1),'device_id',(SELECT device_id FROM sync_state WHERE workspace_id=NEW.workspace_id),'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 MAX(NEW.revision,COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='memories' AND record_key=NEW.id),0)+1),operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 UPDATE memories SET revision=(SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='memories' AND record_key=NEW.id),device_id=(SELECT device_id FROM sync_state WHERE workspace_id=NEW.workspace_id) WHERE id=NEW.id;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='memories' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='memories' AND operation!='put');
 END;
DROP TRIGGER sync_memories_update;
CREATE TRIGGER sync_memories_update AFTER UPDATE ON memories
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) AND NEW.may_send=1) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='memories' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='memories' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.text IS NOT OLD.text OR NEW.kind IS NOT OLD.kind OR NEW.scope IS NOT OLD.scope OR NEW.project_id IS NOT OLD.project_id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.authority IS NOT OLD.authority OR NEW.source_thread_id IS NOT OLD.source_thread_id OR NEW.source_message_id IS NOT OLD.source_message_id OR NEW.source_artifact_id IS NOT OLD.source_artifact_id OR NEW.extraction_method IS NOT OLD.extraction_method OR NEW.extraction_model IS NOT OLD.extraction_model OR NEW.confidence IS NOT OLD.confidence OR NEW.last_verified_at IS NOT OLD.last_verified_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.status IS NOT OLD.status OR NEW.sensitivity IS NOT OLD.sensitivity OR NEW.may_send IS NOT OLD.may_send OR NEW.superseded_by_id IS NOT OLD.superseded_by_id OR NEW.rationale IS NOT OLD.rationale OR NEW.alternatives IS NOT OLD.alternatives OR NEW.task_status IS NOT OLD.task_status OR NEW.depends_on IS NOT OLD.depends_on OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.deleted_at IS NOT OLD.deleted_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'memories',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='memories' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) AND NEW.may_send=1) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) AND NEW.may_send=1) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'text',NEW.text,'kind',NEW.kind,'scope',NEW.scope,'project_id',NEW.project_id,'thread_id',NEW.thread_id,'authority',NEW.authority,'source_thread_id',NEW.source_thread_id,'source_message_id',NEW.source_message_id,'source_artifact_id',NEW.source_artifact_id,'extraction_method',NEW.extraction_method,'extraction_model',NEW.extraction_model,'confidence',NEW.confidence,'last_verified_at',NEW.last_verified_at,'expires_at',NEW.expires_at,'status',NEW.status,'sensitivity',NEW.sensitivity,'may_send',NEW.may_send,'superseded_by_id',NEW.superseded_by_id,'rationale',NEW.rationale,'alternatives',NEW.alternatives,'task_status',NEW.task_status,'depends_on',NEW.depends_on,'revision',MAX(NEW.revision,COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='memories' AND record_key=NEW.id),0)+1),'device_id',(SELECT device_id FROM sync_state WHERE workspace_id=NEW.workspace_id),'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 MAX(NEW.revision,COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='memories' AND record_key=NEW.id),0)+1),operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 UPDATE memories SET revision=(SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='memories' AND record_key=NEW.id),device_id=(SELECT device_id FROM sync_state WHERE workspace_id=NEW.workspace_id) WHERE id=NEW.id;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='memories' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='memories' AND operation!='put');
 END;
DROP TRIGGER sync_memories_delete;
CREATE TRIGGER sync_memories_delete AFTER DELETE ON memories
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='memories' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'memories',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='memories' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'text',OLD.text,'kind',OLD.kind,'scope',OLD.scope,'project_id',OLD.project_id,'thread_id',OLD.thread_id,'authority',OLD.authority,'source_thread_id',OLD.source_thread_id,'source_message_id',OLD.source_message_id,'source_artifact_id',OLD.source_artifact_id,'extraction_method',OLD.extraction_method,'extraction_model',OLD.extraction_model,'confidence',OLD.confidence,'last_verified_at',OLD.last_verified_at,'expires_at',OLD.expires_at,'status',OLD.status,'sensitivity',OLD.sensitivity,'may_send',OLD.may_send,'superseded_by_id',OLD.superseded_by_id,'rationale',OLD.rationale,'alternatives',OLD.alternatives,'task_status',OLD.task_status,'depends_on',OLD.depends_on,'revision',COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='memories' AND record_key=OLD.id),0)+1,'device_id',(SELECT device_id FROM sync_state WHERE workspace_id=OLD.workspace_id),'created_at',OLD.created_at,'updated_at',OLD.updated_at,'deleted_at',OLD.deleted_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='memories' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='memories' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='memories' AND operation!='put');
 END;
DROP TRIGGER sync_message_memories_insert;
CREATE TRIGGER sync_message_memories_insert AFTER INSERT ON message_memories
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) AND EXISTS (SELECT 1 FROM memories m WHERE m.id=NEW.memory_id AND m.may_send=1) AND NOT EXISTS (SELECT 1 FROM memories m JOIN projects p ON p.id=m.project_id WHERE m.id=NEW.memory_id AND p.privacy_mode='local_only')) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_memories' AND record_key=json_array(NEW.message_id,NEW.memory_id))))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'message_memories',json_array(NEW.message_id,NEW.memory_id),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_memories' AND record_key=json_array(NEW.message_id,NEW.memory_id)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) AND EXISTS (SELECT 1 FROM memories m WHERE m.id=NEW.memory_id AND m.may_send=1) AND NOT EXISTS (SELECT 1 FROM memories m JOIN projects p ON p.id=m.project_id WHERE m.id=NEW.memory_id AND p.privacy_mode='local_only')) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) AND EXISTS (SELECT 1 FROM memories m WHERE m.id=NEW.memory_id AND m.may_send=1) AND NOT EXISTS (SELECT 1 FROM memories m JOIN projects p ON p.id=m.project_id WHERE m.id=NEW.memory_id AND p.privacy_mode='local_only')) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('message_id',NEW.message_id,'memory_id',NEW.memory_id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'created_at',NEW.created_at,'reason',NEW.reason,'score',NEW.score) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_memories' AND record_key=json_array(NEW.message_id,NEW.memory_id)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='message_memories' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_memories' AND operation!='put');
 END;
DROP TRIGGER sync_message_memories_update;
CREATE TRIGGER sync_message_memories_update AFTER UPDATE ON message_memories
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) AND EXISTS (SELECT 1 FROM memories m WHERE m.id=NEW.memory_id AND m.may_send=1) AND NOT EXISTS (SELECT 1 FROM memories m JOIN projects p ON p.id=m.project_id WHERE m.id=NEW.memory_id AND p.privacy_mode='local_only')) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_memories' AND record_key=json_array(NEW.message_id,NEW.memory_id)))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_memories' AND record_key=json_array(NEW.message_id,NEW.memory_id)) OR (NEW.message_id IS NOT OLD.message_id OR NEW.memory_id IS NOT OLD.memory_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.created_at IS NOT OLD.created_at OR NEW.reason IS NOT OLD.reason OR NEW.score IS NOT OLD.score))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'message_memories',json_array(NEW.message_id,NEW.memory_id),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_memories' AND record_key=json_array(NEW.message_id,NEW.memory_id)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) AND EXISTS (SELECT 1 FROM memories m WHERE m.id=NEW.memory_id AND m.may_send=1) AND NOT EXISTS (SELECT 1 FROM memories m JOIN projects p ON p.id=m.project_id WHERE m.id=NEW.memory_id AND p.privacy_mode='local_only')) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=NEW.message_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))) AND EXISTS (SELECT 1 FROM memories m WHERE m.id=NEW.memory_id AND m.may_send=1) AND NOT EXISTS (SELECT 1 FROM memories m JOIN projects p ON p.id=m.project_id WHERE m.id=NEW.memory_id AND p.privacy_mode='local_only')) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('message_id',NEW.message_id,'memory_id',NEW.memory_id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'created_at',NEW.created_at,'reason',NEW.reason,'score',NEW.score) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_memories' AND record_key=json_array(NEW.message_id,NEW.memory_id)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='message_memories' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='message_memories' AND operation!='put');
 END;
DROP TRIGGER sync_message_memories_delete;
CREATE TRIGGER sync_message_memories_delete AFTER DELETE ON message_memories
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='message_memories' AND record_key=json_array(OLD.message_id,OLD.memory_id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'message_memories',json_array(OLD.message_id,OLD.memory_id),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='message_memories' AND record_key=json_array(OLD.message_id,OLD.memory_id)),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('message_id',OLD.message_id,'memory_id',OLD.memory_id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'created_at',OLD.created_at,'reason',OLD.reason,'score',OLD.score) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='message_memories' AND record_key=json_array(OLD.message_id,OLD.memory_id)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='message_memories' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='message_memories' AND operation!='put');
 END;
DROP TRIGGER sync_artifacts_insert;
CREATE TRIGGER sync_artifacts_insert AFTER INSERT ON artifacts
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifacts' AND record_key=json_array(NEW.thread_id,NEW.key))))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'artifacts',json_array(NEW.thread_id,NEW.key),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifacts' AND record_key=json_array(NEW.thread_id,NEW.key)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'thread_id',NEW.thread_id,'key',NEW.key,'title',NEW.title,'type',NEW.type,'language',NEW.language,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifacts' AND record_key=json_array(NEW.thread_id,NEW.key)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='artifacts' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifacts' AND operation!='put');
 END;
DROP TRIGGER sync_artifacts_update;
CREATE TRIGGER sync_artifacts_update AFTER UPDATE ON artifacts
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifacts' AND record_key=json_array(NEW.thread_id,NEW.key)))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifacts' AND record_key=json_array(NEW.thread_id,NEW.key)) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.key IS NOT OLD.key OR NEW.title IS NOT OLD.title OR NEW.type IS NOT OLD.type OR NEW.language IS NOT OLD.language OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.deleted_at IS NOT OLD.deleted_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'artifacts',json_array(NEW.thread_id,NEW.key),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifacts' AND record_key=json_array(NEW.thread_id,NEW.key)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'thread_id',NEW.thread_id,'key',NEW.key,'title',NEW.title,'type',NEW.type,'language',NEW.language,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifacts' AND record_key=json_array(NEW.thread_id,NEW.key)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='artifacts' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifacts' AND operation!='put');
 END;
DROP TRIGGER sync_artifacts_delete;
CREATE TRIGGER sync_artifacts_delete AFTER DELETE ON artifacts
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='artifacts' AND record_key=json_array(OLD.thread_id,OLD.key)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'artifacts',json_array(OLD.thread_id,OLD.key),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='artifacts' AND record_key=json_array(OLD.thread_id,OLD.key)),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'thread_id',OLD.thread_id,'key',OLD.key,'title',OLD.title,'type',OLD.type,'language',OLD.language,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'deleted_at',OLD.deleted_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='artifacts' AND record_key=json_array(OLD.thread_id,OLD.key)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='artifacts' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='artifacts' AND operation!='put');
 END;
DROP TRIGGER sync_artifact_versions_insert;
CREATE TRIGGER sync_artifact_versions_insert AFTER INSERT ON artifact_versions
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM artifacts a JOIN threads t ON t.id=a.thread_id WHERE a.id=NEW.artifact_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_versions' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'artifact_versions',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_versions' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM artifacts a JOIN threads t ON t.id=a.thread_id WHERE a.id=NEW.artifact_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM artifacts a JOIN threads t ON t.id=a.thread_id WHERE a.id=NEW.artifact_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'artifact_id',NEW.artifact_id,'version',NEW.version,'content',NEW.content,'source',NEW.source,'message_id',NEW.message_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_versions' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='artifact_versions' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_versions' AND operation!='put');
 END;
DROP TRIGGER sync_artifact_versions_update;
CREATE TRIGGER sync_artifact_versions_update AFTER UPDATE ON artifact_versions
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM artifacts a JOIN threads t ON t.id=a.thread_id WHERE a.id=NEW.artifact_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_versions' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_versions' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.artifact_id IS NOT OLD.artifact_id OR NEW.version IS NOT OLD.version OR NEW.content IS NOT OLD.content OR NEW.source IS NOT OLD.source OR NEW.message_id IS NOT OLD.message_id OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'artifact_versions',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_versions' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM artifacts a JOIN threads t ON t.id=a.thread_id WHERE a.id=NEW.artifact_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM artifacts a JOIN threads t ON t.id=a.thread_id WHERE a.id=NEW.artifact_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'artifact_id',NEW.artifact_id,'version',NEW.version,'content',NEW.content,'source',NEW.source,'message_id',NEW.message_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_versions' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='artifact_versions' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='artifact_versions' AND operation!='put');
 END;
DROP TRIGGER sync_artifact_versions_delete;
CREATE TRIGGER sync_artifact_versions_delete AFTER DELETE ON artifact_versions
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='artifact_versions' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'artifact_versions',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='artifact_versions' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'artifact_id',OLD.artifact_id,'version',OLD.version,'content',OLD.content,'source',OLD.source,'message_id',OLD.message_id,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='artifact_versions' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='artifact_versions' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='artifact_versions' AND operation!='put');
 END;
DROP TRIGGER sync_user_instructions_insert;
CREATE TRIGGER sync_user_instructions_insert AFTER INSERT ON user_instructions
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((1) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='user_instructions' AND record_key=json_array(NEW.workspace_id,NEW.user_id))))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'user_instructions',json_array(NEW.workspace_id,NEW.user_id),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='user_instructions' AND record_key=json_array(NEW.workspace_id,NEW.user_id)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (1) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (1) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'about_you',NEW.about_you,'how_to_answer',NEW.how_to_answer,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='user_instructions' AND record_key=json_array(NEW.workspace_id,NEW.user_id)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='user_instructions' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='user_instructions' AND operation!='put');
 END;
DROP TRIGGER sync_user_instructions_update;
CREATE TRIGGER sync_user_instructions_update AFTER UPDATE ON user_instructions
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((1) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='user_instructions' AND record_key=json_array(NEW.workspace_id,NEW.user_id)))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='user_instructions' AND record_key=json_array(NEW.workspace_id,NEW.user_id)) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.about_you IS NOT OLD.about_you OR NEW.how_to_answer IS NOT OLD.how_to_answer OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'user_instructions',json_array(NEW.workspace_id,NEW.user_id),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='user_instructions' AND record_key=json_array(NEW.workspace_id,NEW.user_id)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (1) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (1) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'about_you',NEW.about_you,'how_to_answer',NEW.how_to_answer,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='user_instructions' AND record_key=json_array(NEW.workspace_id,NEW.user_id)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='user_instructions' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='user_instructions' AND operation!='put');
 END;
DROP TRIGGER sync_user_instructions_delete;
CREATE TRIGGER sync_user_instructions_delete AFTER DELETE ON user_instructions
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='user_instructions' AND record_key=json_array(OLD.workspace_id,OLD.user_id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'user_instructions',json_array(OLD.workspace_id,OLD.user_id),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='user_instructions' AND record_key=json_array(OLD.workspace_id,OLD.user_id)),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'about_you',OLD.about_you,'how_to_answer',OLD.how_to_answer,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='user_instructions' AND record_key=json_array(OLD.workspace_id,OLD.user_id)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='user_instructions' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='user_instructions' AND operation!='put');
 END;
DROP TRIGGER sync_budgets_insert;
CREATE TRIGGER sync_budgets_insert AFTER INSERT ON budgets
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='budgets' AND record_key=json_array(NEW.scope,NEW.project_id,NEW.period))))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'budgets',json_array(NEW.scope,NEW.project_id,NEW.period),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='budgets' AND record_key=json_array(NEW.scope,NEW.project_id,NEW.period)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'scope',NEW.scope,'project_id',NEW.project_id,'period',NEW.period,'limit_micro_usd',NEW.limit_micro_usd,'hard_stop',NEW.hard_stop,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='budgets' AND record_key=json_array(NEW.scope,NEW.project_id,NEW.period)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='budgets' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='budgets' AND operation!='put');
 END;
DROP TRIGGER sync_budgets_update;
CREATE TRIGGER sync_budgets_update AFTER UPDATE ON budgets
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='budgets' AND record_key=json_array(NEW.scope,NEW.project_id,NEW.period)))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='budgets' AND record_key=json_array(NEW.scope,NEW.project_id,NEW.period)) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.scope IS NOT OLD.scope OR NEW.project_id IS NOT OLD.project_id OR NEW.period IS NOT OLD.period OR NEW.limit_micro_usd IS NOT OLD.limit_micro_usd OR NEW.hard_stop IS NOT OLD.hard_stop OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'budgets',json_array(NEW.scope,NEW.project_id,NEW.period),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='budgets' AND record_key=json_array(NEW.scope,NEW.project_id,NEW.period)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'scope',NEW.scope,'project_id',NEW.project_id,'period',NEW.period,'limit_micro_usd',NEW.limit_micro_usd,'hard_stop',NEW.hard_stop,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='budgets' AND record_key=json_array(NEW.scope,NEW.project_id,NEW.period)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='budgets' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='budgets' AND operation!='put');
 END;
DROP TRIGGER sync_budgets_delete;
CREATE TRIGGER sync_budgets_delete AFTER DELETE ON budgets
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='budgets' AND record_key=json_array(OLD.scope,OLD.project_id,OLD.period)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'budgets',json_array(OLD.scope,OLD.project_id,OLD.period),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='budgets' AND record_key=json_array(OLD.scope,OLD.project_id,OLD.period)),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'scope',OLD.scope,'project_id',OLD.project_id,'period',OLD.period,'limit_micro_usd',OLD.limit_micro_usd,'hard_stop',OLD.hard_stop,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='budgets' AND record_key=json_array(OLD.scope,OLD.project_id,OLD.period)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='budgets' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='budgets' AND operation!='put');
 END;
DROP TRIGGER sync_golden_prompts_insert;
CREATE TRIGGER sync_golden_prompts_insert AFTER INSERT ON golden_prompts
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((1) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='golden_prompts' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'golden_prompts',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='golden_prompts' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (1) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (1) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'prompt',NEW.prompt,'expected_tier',NEW.expected_tier,'intent',NEW.intent,'complexity',NEW.complexity,'needs_context',NEW.needs_context,'notes',NEW.notes,'position',NEW.position,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='golden_prompts' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='golden_prompts' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='golden_prompts' AND operation!='put');
 END;
DROP TRIGGER sync_golden_prompts_update;
CREATE TRIGGER sync_golden_prompts_update AFTER UPDATE ON golden_prompts
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((1) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='golden_prompts' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='golden_prompts' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.prompt IS NOT OLD.prompt OR NEW.expected_tier IS NOT OLD.expected_tier OR NEW.intent IS NOT OLD.intent OR NEW.complexity IS NOT OLD.complexity OR NEW.needs_context IS NOT OLD.needs_context OR NEW.notes IS NOT OLD.notes OR NEW.position IS NOT OLD.position OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'golden_prompts',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='golden_prompts' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (1) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (1) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'prompt',NEW.prompt,'expected_tier',NEW.expected_tier,'intent',NEW.intent,'complexity',NEW.complexity,'needs_context',NEW.needs_context,'notes',NEW.notes,'position',NEW.position,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='golden_prompts' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='golden_prompts' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='golden_prompts' AND operation!='put');
 END;
DROP TRIGGER sync_golden_prompts_delete;
CREATE TRIGGER sync_golden_prompts_delete AFTER DELETE ON golden_prompts
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='golden_prompts' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'golden_prompts',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='golden_prompts' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'prompt',OLD.prompt,'expected_tier',OLD.expected_tier,'intent',OLD.intent,'complexity',OLD.complexity,'needs_context',OLD.needs_context,'notes',OLD.notes,'position',OLD.position,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='golden_prompts' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='golden_prompts' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='golden_prompts' AND operation!='put');
 END;
DROP TRIGGER sync_web_pages_insert;
CREATE TRIGGER sync_web_pages_insert AFTER INSERT ON web_pages
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1 AND (f.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=f.project_id AND p.privacy_mode!='local_only')) AND (f.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=f.thread_id AND t.incognito=0 AND t.local_only=0))) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id)) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='web_pages' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'web_pages',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='web_pages' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1 AND (f.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=f.project_id AND p.privacy_mode!='local_only')) AND (f.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=f.thread_id AND t.incognito=0 AND t.local_only=0))) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id)) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1 AND (f.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=f.project_id AND p.privacy_mode!='local_only')) AND (f.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=f.thread_id AND t.incognito=0 AND t.local_only=0))) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id)) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'url',NEW.url,'file_id',NEW.file_id,'title',NEW.title,'fetched_at',NEW.fetched_at,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='web_pages' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='web_pages' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='web_pages' AND operation!='put');
 END;
DROP TRIGGER sync_web_pages_update;
CREATE TRIGGER sync_web_pages_update AFTER UPDATE ON web_pages
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1 AND (f.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=f.project_id AND p.privacy_mode!='local_only')) AND (f.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=f.thread_id AND t.incognito=0 AND t.local_only=0))) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id)) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='web_pages' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='web_pages' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.url IS NOT OLD.url OR NEW.file_id IS NOT OLD.file_id OR NEW.title IS NOT OLD.title OR NEW.fetched_at IS NOT OLD.fetched_at OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'web_pages',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='web_pages' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1 AND (f.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=f.project_id AND p.privacy_mode!='local_only')) AND (f.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=f.thread_id AND t.incognito=0 AND t.local_only=0))) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id)) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1 AND (f.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=f.project_id AND p.privacy_mode!='local_only')) AND (f.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=f.thread_id AND t.incognito=0 AND t.local_only=0))) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id)) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'url',NEW.url,'file_id',NEW.file_id,'title',NEW.title,'fetched_at',NEW.fetched_at,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='web_pages' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='web_pages' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='web_pages' AND operation!='put');
 END;
DROP TRIGGER sync_web_pages_delete;
CREATE TRIGGER sync_web_pages_delete AFTER DELETE ON web_pages
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='web_pages' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'web_pages',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='web_pages' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'url',OLD.url,'file_id',OLD.file_id,'title',OLD.title,'fetched_at',OLD.fetched_at,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='web_pages' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='web_pages' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='web_pages' AND operation!='put');
 END;
DROP TRIGGER sync_imports_insert;
CREATE TRIGGER sync_imports_insert AFTER INSERT ON imports
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='imports' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'imports',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='imports' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'source',NEW.source,'external_id',NEW.external_id,'thread_id',NEW.thread_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='imports' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='imports' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='imports' AND operation!='put');
 END;
DROP TRIGGER sync_imports_update;
CREATE TRIGGER sync_imports_update AFTER UPDATE ON imports
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='imports' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='imports' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.source IS NOT OLD.source OR NEW.external_id IS NOT OLD.external_id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'imports',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='imports' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'source',NEW.source,'external_id',NEW.external_id,'thread_id',NEW.thread_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='imports' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='imports' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='imports' AND operation!='put');
 END;
DROP TRIGGER sync_imports_delete;
CREATE TRIGGER sync_imports_delete AFTER DELETE ON imports
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='imports' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'imports',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='imports' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'source',OLD.source,'external_id',OLD.external_id,'thread_id',OLD.thread_id,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='imports' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='imports' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='imports' AND operation!='put');
 END;
DROP TRIGGER sync_thread_tags_insert;
CREATE TRIGGER sync_thread_tags_insert AFTER INSERT ON thread_tags
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_tags' AND record_key=json_array(NEW.thread_id,NEW.tag))))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'thread_tags',json_array(NEW.thread_id,NEW.tag),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_tags' AND record_key=json_array(NEW.thread_id,NEW.tag)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'thread_id',NEW.thread_id,'tag',NEW.tag,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_tags' AND record_key=json_array(NEW.thread_id,NEW.tag)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='thread_tags' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_tags' AND operation!='put');
 END;
DROP TRIGGER sync_thread_tags_update;
CREATE TRIGGER sync_thread_tags_update AFTER UPDATE ON thread_tags
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_tags' AND record_key=json_array(NEW.thread_id,NEW.tag)))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_tags' AND record_key=json_array(NEW.thread_id,NEW.tag)) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.tag IS NOT OLD.tag OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'thread_tags',json_array(NEW.thread_id,NEW.tag),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_tags' AND record_key=json_array(NEW.thread_id,NEW.tag)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((1) AND (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'thread_id',NEW.thread_id,'tag',NEW.tag,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_tags' AND record_key=json_array(NEW.thread_id,NEW.tag)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='thread_tags' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='thread_tags' AND operation!='put');
 END;
DROP TRIGGER sync_thread_tags_delete;
CREATE TRIGGER sync_thread_tags_delete AFTER DELETE ON thread_tags
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='thread_tags' AND record_key=json_array(OLD.thread_id,OLD.tag)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'thread_tags',json_array(OLD.thread_id,OLD.tag),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='thread_tags' AND record_key=json_array(OLD.thread_id,OLD.tag)),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'thread_id',OLD.thread_id,'tag',OLD.tag,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='thread_tags' AND record_key=json_array(OLD.thread_id,OLD.tag)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='thread_tags' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='thread_tags' AND operation!='put');
 END;
DROP TRIGGER sync_prompts_insert;
CREATE TRIGGER sync_prompts_insert AFTER INSERT ON prompts
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((NEW.sync_local_only=0 AND ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='prompts' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'prompts',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='prompts' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (NEW.sync_local_only=0 AND ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (NEW.sync_local_only=0 AND ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'project_id',NEW.project_id,'name',NEW.name,'body',NEW.body,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='prompts' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='prompts' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='prompts' AND operation!='put');
 END;
DROP TRIGGER sync_prompts_update;
CREATE TRIGGER sync_prompts_update AFTER UPDATE ON prompts
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((NEW.sync_local_only=0 AND ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='prompts' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='prompts' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.project_id IS NOT OLD.project_id OR NEW.name IS NOT OLD.name OR NEW.body IS NOT OLD.body OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'prompts',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='prompts' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (NEW.sync_local_only=0 AND ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (NEW.sync_local_only=0 AND ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'project_id',NEW.project_id,'name',NEW.name,'body',NEW.body,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='prompts' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='prompts' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='prompts' AND operation!='put');
 END;
DROP TRIGGER sync_prompts_delete;
CREATE TRIGGER sync_prompts_delete AFTER DELETE ON prompts
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='prompts' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'prompts',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='prompts' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'project_id',OLD.project_id,'name',OLD.name,'body',OLD.body,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='prompts' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='prompts' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='prompts' AND operation!='put');
 END;
DROP TRIGGER sync_egress_rules_insert;
CREATE TRIGGER sync_egress_rules_insert AFTER INSERT ON egress_rules
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='egress_rules' AND record_key=json_array(NEW.project_id,NEW.provider))))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'egress_rules',json_array(NEW.project_id,NEW.provider),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='egress_rules' AND record_key=json_array(NEW.project_id,NEW.provider)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'project_id',NEW.project_id,'provider',NEW.provider,'allow',NEW.allow,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='egress_rules' AND record_key=json_array(NEW.project_id,NEW.provider)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='egress_rules' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='egress_rules' AND operation!='put');
 END;
DROP TRIGGER sync_egress_rules_update;
CREATE TRIGGER sync_egress_rules_update AFTER UPDATE ON egress_rules
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='egress_rules' AND record_key=json_array(NEW.project_id,NEW.provider)))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='egress_rules' AND record_key=json_array(NEW.project_id,NEW.provider)) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.project_id IS NOT OLD.project_id OR NEW.provider IS NOT OLD.provider OR NEW.allow IS NOT OLD.allow OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'egress_rules',json_array(NEW.project_id,NEW.provider),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='egress_rules' AND record_key=json_array(NEW.project_id,NEW.provider)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'project_id',NEW.project_id,'provider',NEW.provider,'allow',NEW.allow,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='egress_rules' AND record_key=json_array(NEW.project_id,NEW.provider)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='egress_rules' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='egress_rules' AND operation!='put');
 END;
DROP TRIGGER sync_egress_rules_delete;
CREATE TRIGGER sync_egress_rules_delete AFTER DELETE ON egress_rules
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='egress_rules' AND record_key=json_array(OLD.project_id,OLD.provider)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'egress_rules',json_array(OLD.project_id,OLD.provider),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='egress_rules' AND record_key=json_array(OLD.project_id,OLD.provider)),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'project_id',OLD.project_id,'provider',OLD.provider,'allow',OLD.allow,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='egress_rules' AND record_key=json_array(OLD.project_id,OLD.provider)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='egress_rules' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='egress_rules' AND operation!='put');
 END;
DROP TRIGGER sync_request_log_insert;
CREATE TRIGGER sync_request_log_insert AFTER INSERT ON request_log
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((1) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'request_log',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((1) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((1) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'thread_id',NEW.thread_id,'message_id',NEW.message_id,'purpose',NEW.purpose,'provider',NEW.provider,'model',NEW.model,'attempt',NEW.attempt,'input_tokens',NEW.input_tokens,'output_tokens',NEW.output_tokens,'cached_input_tokens',NEW.cached_input_tokens,'cache_write_tokens',NEW.cache_write_tokens,'reasoning_tokens',NEW.reasoning_tokens,'cost_micro_usd',NEW.cost_micro_usd,'price_version',NEW.price_version,'latency_ms',NEW.latency_ms,'ttft_ms',NEW.ttft_ms,'http_status',NEW.http_status,'error_code',NEW.error_code,'error_message',NEW.error_message,'provider_request_id',NEW.provider_request_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'web_search_calls',NEW.web_search_calls,'tier',NEW.tier,'route_rule_id',NEW.route_rule_id,'surface',NEW.surface) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND operation!='put');
 END;
DROP TRIGGER sync_request_log_update;
CREATE TRIGGER sync_request_log_update AFTER UPDATE ON request_log
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((1) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.message_id IS NOT OLD.message_id OR NEW.purpose IS NOT OLD.purpose OR NEW.provider IS NOT OLD.provider OR NEW.model IS NOT OLD.model OR NEW.attempt IS NOT OLD.attempt OR NEW.input_tokens IS NOT OLD.input_tokens OR NEW.output_tokens IS NOT OLD.output_tokens OR NEW.cached_input_tokens IS NOT OLD.cached_input_tokens OR NEW.cache_write_tokens IS NOT OLD.cache_write_tokens OR NEW.reasoning_tokens IS NOT OLD.reasoning_tokens OR NEW.cost_micro_usd IS NOT OLD.cost_micro_usd OR NEW.price_version IS NOT OLD.price_version OR NEW.latency_ms IS NOT OLD.latency_ms OR NEW.ttft_ms IS NOT OLD.ttft_ms OR NEW.http_status IS NOT OLD.http_status OR NEW.error_code IS NOT OLD.error_code OR NEW.error_message IS NOT OLD.error_message OR NEW.provider_request_id IS NOT OLD.provider_request_id OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.web_search_calls IS NOT OLD.web_search_calls OR NEW.tier IS NOT OLD.tier OR NEW.route_rule_id IS NOT OLD.route_rule_id OR NEW.surface IS NOT OLD.surface))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'request_log',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((1) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((1) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'thread_id',NEW.thread_id,'message_id',NEW.message_id,'purpose',NEW.purpose,'provider',NEW.provider,'model',NEW.model,'attempt',NEW.attempt,'input_tokens',NEW.input_tokens,'output_tokens',NEW.output_tokens,'cached_input_tokens',NEW.cached_input_tokens,'cache_write_tokens',NEW.cache_write_tokens,'reasoning_tokens',NEW.reasoning_tokens,'cost_micro_usd',NEW.cost_micro_usd,'price_version',NEW.price_version,'latency_ms',NEW.latency_ms,'ttft_ms',NEW.ttft_ms,'http_status',NEW.http_status,'error_code',NEW.error_code,'error_message',NEW.error_message,'provider_request_id',NEW.provider_request_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'web_search_calls',NEW.web_search_calls,'tier',NEW.tier,'route_rule_id',NEW.route_rule_id,'surface',NEW.surface) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND operation!='put');
 END;
DROP TRIGGER sync_request_log_delete;
CREATE TRIGGER sync_request_log_delete AFTER DELETE ON request_log
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='request_log' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'request_log',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='request_log' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'thread_id',OLD.thread_id,'message_id',OLD.message_id,'purpose',OLD.purpose,'provider',OLD.provider,'model',OLD.model,'attempt',OLD.attempt,'input_tokens',OLD.input_tokens,'output_tokens',OLD.output_tokens,'cached_input_tokens',OLD.cached_input_tokens,'cache_write_tokens',OLD.cache_write_tokens,'reasoning_tokens',OLD.reasoning_tokens,'cost_micro_usd',OLD.cost_micro_usd,'price_version',OLD.price_version,'latency_ms',OLD.latency_ms,'ttft_ms',OLD.ttft_ms,'http_status',OLD.http_status,'error_code',OLD.error_code,'error_message',OLD.error_message,'provider_request_id',OLD.provider_request_id,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'web_search_calls',OLD.web_search_calls,'tier',OLD.tier,'route_rule_id',OLD.route_rule_id,'surface',OLD.surface) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='request_log' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='request_log' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='request_log' AND operation!='put');
 END;
DROP TRIGGER sync_settings_insert;
CREATE TRIGGER sync_settings_insert AFTER INSERT ON settings
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((NEW.key IN ('memory.suggest','memory.budget_tokens','models.defaults','routing.policy','routing.project_rules','routing.overrides','catalog.price_edits','catalog.custom_models','notifications')) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='settings' AND record_key=json_array(NEW.key))))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'settings',json_array(NEW.key),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='settings' AND record_key=json_array(NEW.key)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (NEW.key IN ('memory.suggest','memory.budget_tokens','models.defaults','routing.policy','routing.project_rules','routing.overrides','catalog.price_edits','catalog.custom_models','notifications')) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (NEW.key IN ('memory.suggest','memory.budget_tokens','models.defaults','routing.policy','routing.project_rules','routing.overrides','catalog.price_edits','catalog.custom_models','notifications')) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'key',NEW.key,'value',NEW.value,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='settings' AND record_key=json_array(NEW.key)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='settings' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='settings' AND operation!='put');
 END;
DROP TRIGGER sync_settings_update;
CREATE TRIGGER sync_settings_update AFTER UPDATE ON settings
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((NEW.key IN ('memory.suggest','memory.budget_tokens','models.defaults','routing.policy','routing.project_rules','routing.overrides','catalog.price_edits','catalog.custom_models','notifications')) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='settings' AND record_key=json_array(NEW.key)))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='settings' AND record_key=json_array(NEW.key)) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.key IS NOT OLD.key OR NEW.value IS NOT OLD.value OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'settings',json_array(NEW.key),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='settings' AND record_key=json_array(NEW.key)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (NEW.key IN ('memory.suggest','memory.budget_tokens','models.defaults','routing.policy','routing.project_rules','routing.overrides','catalog.price_edits','catalog.custom_models','notifications')) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (NEW.key IN ('memory.suggest','memory.budget_tokens','models.defaults','routing.policy','routing.project_rules','routing.overrides','catalog.price_edits','catalog.custom_models','notifications')) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'key',NEW.key,'value',NEW.value,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='settings' AND record_key=json_array(NEW.key)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='settings' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='settings' AND operation!='put');
 END;
DROP TRIGGER sync_settings_delete;
CREATE TRIGGER sync_settings_delete AFTER DELETE ON settings
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='settings' AND record_key=json_array(OLD.key)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'settings',json_array(OLD.key),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='settings' AND record_key=json_array(OLD.key)),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'key',OLD.key,'value',OLD.value,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='settings' AND record_key=json_array(OLD.key)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='settings' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='settings' AND operation!='put');
 END;
DROP TRIGGER sync_runs_insert;
CREATE TRIGGER sync_runs_insert AFTER INSERT ON runs
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((NEW.status IN ('done','stopped','error')) AND ((((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'runs',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'project_id',NEW.project_id,'thread_id',NEW.thread_id,'message_id',NEW.message_id,'task',NEW.task,'kind',NEW.kind,'mode',NEW.mode,'provider',NEW.provider,'model',NEW.model,'status',NEW.status,'cap_micro_usd',NEW.cap_micro_usd,'spent_micro_usd',NEW.spent_micro_usd,'note',NEW.note,'summary',NEW.summary,'summary_upto',NEW.summary_upto,'branch',NEW.branch,'plan',NEW.plan,'planner',NEW.planner,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'started_at',NEW.started_at,'waited_ms',NEW.waited_ms) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND operation!='put');
 END;
DROP TRIGGER sync_runs_update;
CREATE TRIGGER sync_runs_update AFTER UPDATE ON runs
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((NEW.status IN ('done','stopped','error')) AND ((((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.project_id IS NOT OLD.project_id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.message_id IS NOT OLD.message_id OR NEW.task IS NOT OLD.task OR NEW.kind IS NOT OLD.kind OR NEW.mode IS NOT OLD.mode OR NEW.provider IS NOT OLD.provider OR NEW.model IS NOT OLD.model OR NEW.status IS NOT OLD.status OR NEW.cap_micro_usd IS NOT OLD.cap_micro_usd OR NEW.spent_micro_usd IS NOT OLD.spent_micro_usd OR NEW.note IS NOT OLD.note OR NEW.summary IS NOT OLD.summary OR NEW.summary_upto IS NOT OLD.summary_upto OR NEW.branch IS NOT OLD.branch OR NEW.plan IS NOT OLD.plan OR NEW.planner IS NOT OLD.planner OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.started_at IS NOT OLD.started_at OR NEW.waited_ms IS NOT OLD.waited_ms))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'runs',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'project_id',NEW.project_id,'thread_id',NEW.thread_id,'message_id',NEW.message_id,'task',NEW.task,'kind',NEW.kind,'mode',NEW.mode,'provider',NEW.provider,'model',NEW.model,'status',NEW.status,'cap_micro_usd',NEW.cap_micro_usd,'spent_micro_usd',NEW.spent_micro_usd,'note',NEW.note,'summary',NEW.summary,'summary_upto',NEW.summary_upto,'branch',NEW.branch,'plan',NEW.plan,'planner',NEW.planner,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'started_at',NEW.started_at,'waited_ms',NEW.waited_ms) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND operation!='put');
 END;
DROP TRIGGER sync_runs_delete;
CREATE TRIGGER sync_runs_delete AFTER DELETE ON runs
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='runs' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'runs',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='runs' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'project_id',OLD.project_id,'thread_id',OLD.thread_id,'message_id',OLD.message_id,'task',OLD.task,'kind',OLD.kind,'mode',OLD.mode,'provider',OLD.provider,'model',OLD.model,'status',OLD.status,'cap_micro_usd',OLD.cap_micro_usd,'spent_micro_usd',OLD.spent_micro_usd,'note',OLD.note,'summary',OLD.summary,'summary_upto',OLD.summary_upto,'branch',OLD.branch,'plan',OLD.plan,'planner',OLD.planner,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'started_at',OLD.started_at,'waited_ms',OLD.waited_ms) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='runs' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='runs' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='runs' AND operation!='put');
 END;
DROP TRIGGER sync_run_steps_insert;
CREATE TRIGGER sync_run_steps_insert AFTER INSERT ON run_steps
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id AND r.status IN ('done','stopped','error') AND (((r.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.workspace_id=r.workspace_id AND p.privacy_mode!='local_only'))) AND (r.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=r.thread_id AND t.workspace_id=r.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_steps' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'run_steps',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_steps' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id AND r.status IN ('done','stopped','error') AND (((r.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.workspace_id=r.workspace_id AND p.privacy_mode!='local_only'))) AND (r.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=r.thread_id AND t.workspace_id=r.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id AND r.status IN ('done','stopped','error') AND (((r.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.workspace_id=r.workspace_id AND p.privacy_mode!='local_only'))) AND (r.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=r.thread_id AND t.workspace_id=r.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'run_id',NEW.run_id,'seq',NEW.seq,'kind',NEW.kind,'text',NEW.text,'native',NEW.native,'request_id',NEW.request_id,'tool_name',NEW.tool_name,'tool_call_id',NEW.tool_call_id,'input',NEW.input,'output',NEW.output,'is_error',NEW.is_error,'cost_micro_usd',NEW.cost_micro_usd,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'approval',NEW.approval,'images',NEW.images,'flags',NEW.flags) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_steps' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='run_steps' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_steps' AND operation!='put');
 END;
DROP TRIGGER sync_run_steps_update;
CREATE TRIGGER sync_run_steps_update AFTER UPDATE ON run_steps
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id AND r.status IN ('done','stopped','error') AND (((r.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.workspace_id=r.workspace_id AND p.privacy_mode!='local_only'))) AND (r.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=r.thread_id AND t.workspace_id=r.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_steps' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_steps' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.run_id IS NOT OLD.run_id OR NEW.seq IS NOT OLD.seq OR NEW.kind IS NOT OLD.kind OR NEW.text IS NOT OLD.text OR NEW.native IS NOT OLD.native OR NEW.request_id IS NOT OLD.request_id OR NEW.tool_name IS NOT OLD.tool_name OR NEW.tool_call_id IS NOT OLD.tool_call_id OR NEW.input IS NOT OLD.input OR NEW.output IS NOT OLD.output OR NEW.is_error IS NOT OLD.is_error OR NEW.cost_micro_usd IS NOT OLD.cost_micro_usd OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.approval IS NOT OLD.approval OR NEW.images IS NOT OLD.images OR NEW.flags IS NOT OLD.flags))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'run_steps',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_steps' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id AND r.status IN ('done','stopped','error') AND (((r.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.workspace_id=r.workspace_id AND p.privacy_mode!='local_only'))) AND (r.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=r.thread_id AND t.workspace_id=r.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id AND r.status IN ('done','stopped','error') AND (((r.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.workspace_id=r.workspace_id AND p.privacy_mode!='local_only'))) AND (r.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=r.thread_id AND t.workspace_id=r.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'run_id',NEW.run_id,'seq',NEW.seq,'kind',NEW.kind,'text',NEW.text,'native',NEW.native,'request_id',NEW.request_id,'tool_name',NEW.tool_name,'tool_call_id',NEW.tool_call_id,'input',NEW.input,'output',NEW.output,'is_error',NEW.is_error,'cost_micro_usd',NEW.cost_micro_usd,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'approval',NEW.approval,'images',NEW.images,'flags',NEW.flags) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_steps' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='run_steps' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_steps' AND operation!='put');
 END;
DROP TRIGGER sync_run_steps_delete;
CREATE TRIGGER sync_run_steps_delete AFTER DELETE ON run_steps
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='run_steps' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'run_steps',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='run_steps' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'run_id',OLD.run_id,'seq',OLD.seq,'kind',OLD.kind,'text',OLD.text,'native',OLD.native,'request_id',OLD.request_id,'tool_name',OLD.tool_name,'tool_call_id',OLD.tool_call_id,'input',OLD.input,'output',OLD.output,'is_error',OLD.is_error,'cost_micro_usd',OLD.cost_micro_usd,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'approval',OLD.approval,'images',OLD.images,'flags',OLD.flags) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='run_steps' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='run_steps' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='run_steps' AND operation!='put');
 END;
DROP TRIGGER sync_run_changes_insert;
CREATE TRIGGER sync_run_changes_insert AFTER INSERT ON run_changes
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id AND r.status IN ('done','stopped','error') AND (((r.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.workspace_id=r.workspace_id AND p.privacy_mode!='local_only'))) AND (r.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=r.thread_id AND t.workspace_id=r.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_changes' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'run_changes',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_changes' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id AND r.status IN ('done','stopped','error') AND (((r.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.workspace_id=r.workspace_id AND p.privacy_mode!='local_only'))) AND (r.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=r.thread_id AND t.workspace_id=r.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id AND r.status IN ('done','stopped','error') AND (((r.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.workspace_id=r.workspace_id AND p.privacy_mode!='local_only'))) AND (r.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=r.thread_id AND t.workspace_id=r.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'run_id',NEW.run_id,'step_id',NEW.step_id,'path',NEW.path,'from_path',NEW.from_path,'before',NEW.before,'after',NEW.after,'status',NEW.status,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'before_sha',NEW.before_sha,'after_sha',NEW.after_sha,'batch_id',NEW.batch_id) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_changes' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='run_changes' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_changes' AND operation!='put');
 END;
DROP TRIGGER sync_run_changes_update;
CREATE TRIGGER sync_run_changes_update AFTER UPDATE ON run_changes
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id AND r.status IN ('done','stopped','error') AND (((r.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.workspace_id=r.workspace_id AND p.privacy_mode!='local_only'))) AND (r.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=r.thread_id AND t.workspace_id=r.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_changes' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_changes' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.run_id IS NOT OLD.run_id OR NEW.step_id IS NOT OLD.step_id OR NEW.path IS NOT OLD.path OR NEW.from_path IS NOT OLD.from_path OR NEW.before IS NOT OLD.before OR NEW.after IS NOT OLD.after OR NEW.status IS NOT OLD.status OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.before_sha IS NOT OLD.before_sha OR NEW.after_sha IS NOT OLD.after_sha OR NEW.batch_id IS NOT OLD.batch_id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'run_changes',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_changes' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id AND r.status IN ('done','stopped','error') AND (((r.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.workspace_id=r.workspace_id AND p.privacy_mode!='local_only'))) AND (r.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=r.thread_id AND t.workspace_id=r.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id AND r.status IN ('done','stopped','error') AND (((r.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.workspace_id=r.workspace_id AND p.privacy_mode!='local_only'))) AND (r.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=r.thread_id AND t.workspace_id=r.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'run_id',NEW.run_id,'step_id',NEW.step_id,'path',NEW.path,'from_path',NEW.from_path,'before',NEW.before,'after',NEW.after,'status',NEW.status,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'before_sha',NEW.before_sha,'after_sha',NEW.after_sha,'batch_id',NEW.batch_id) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_changes' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='run_changes' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='run_changes' AND operation!='put');
 END;
DROP TRIGGER sync_run_changes_delete;
CREATE TRIGGER sync_run_changes_delete AFTER DELETE ON run_changes
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='run_changes' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'run_changes',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='run_changes' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'run_id',OLD.run_id,'step_id',OLD.step_id,'path',OLD.path,'from_path',OLD.from_path,'before',OLD.before,'after',OLD.after,'status',OLD.status,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'before_sha',OLD.before_sha,'after_sha',OLD.after_sha,'batch_id',OLD.batch_id) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='run_changes' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='run_changes' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='run_changes' AND operation!='put');
 END;
DROP TRIGGER sync_project_files_insert;
CREATE TRIGGER sync_project_files_insert AFTER INSERT ON project_files
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')) AND EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id)) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='project_files' AND record_key=json_array(NEW.project_id,NEW.file_id))))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'project_files',json_array(NEW.project_id,NEW.file_id),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='project_files' AND record_key=json_array(NEW.project_id,NEW.file_id)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')) AND EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id)) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')) AND EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id)) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'project_id',NEW.project_id,'file_id',NEW.file_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='project_files' AND record_key=json_array(NEW.project_id,NEW.file_id)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='project_files' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='project_files' AND operation!='put');
 END;
DROP TRIGGER sync_project_files_update;
CREATE TRIGGER sync_project_files_update AFTER UPDATE ON project_files
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')) AND EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id)) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='project_files' AND record_key=json_array(NEW.project_id,NEW.file_id)))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='project_files' AND record_key=json_array(NEW.project_id,NEW.file_id)) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.project_id IS NOT OLD.project_id OR NEW.file_id IS NOT OLD.file_id OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.deleted_at IS NOT OLD.deleted_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'project_files',json_array(NEW.project_id,NEW.file_id),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='project_files' AND record_key=json_array(NEW.project_id,NEW.file_id)),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')) AND EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id)) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END,CASE WHEN (CASE WHEN NOT ((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only')) AND EXISTS (SELECT 1 FROM files f WHERE f.id=NEW.file_id AND f.may_send=1) AND NOT EXISTS (SELECT 1 FROM folder_files ff WHERE ff.file_id=NEW.file_id)) THEN 'withdraw' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'project_id',NEW.project_id,'file_id',NEW.file_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='project_files' AND record_key=json_array(NEW.project_id,NEW.file_id)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='project_files' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='project_files' AND operation!='put');
 END;
DROP TRIGGER sync_project_files_delete;
CREATE TRIGGER sync_project_files_delete AFTER DELETE ON project_files
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='project_files' AND record_key=json_array(OLD.project_id,OLD.file_id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'project_files',json_array(OLD.project_id,OLD.file_id),device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='project_files' AND record_key=json_array(OLD.project_id,OLD.file_id)),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'project_id',OLD.project_id,'file_id',OLD.file_id,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'deleted_at',OLD.deleted_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='project_files' AND record_key=json_array(OLD.project_id,OLD.file_id)),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='project_files' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='project_files' AND operation!='put');
 END;

-- Use the database host's clock for the undo deadline, including browser writes with clock skew.
CREATE TABLE sync_pending_deletes (
 id TEXT NOT NULL,workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,table_name TEXT NOT NULL DEFAULT 'threads',
 deadline INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(table_name,id)
);
CREATE TRIGGER sync_thread_delete_deadline AFTER UPDATE OF deleted_at ON threads
 WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND NEW.purged_at IS NULL BEGIN
 INSERT INTO sync_pending_deletes(id,workspace_id,user_id,deadline,created_at,updated_at)
 VALUES(NEW.id,NEW.workspace_id,NEW.user_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)+8000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(table_name,id) DO UPDATE SET deadline=excluded.deadline,updated_at=excluded.updated_at;
END;
CREATE TRIGGER sync_thread_delete_undone AFTER UPDATE OF deleted_at,purged_at ON threads
 WHEN NEW.deleted_at IS NULL OR NEW.purged_at IS NOT NULL BEGIN
 DELETE FROM sync_pending_deletes WHERE table_name='threads' AND id=NEW.id AND workspace_id=NEW.workspace_id;
END;
CREATE TRIGGER sync_thread_delete_finished AFTER DELETE ON threads BEGIN
 DELETE FROM sync_pending_deletes WHERE table_name='threads' AND id=OLD.id AND workspace_id=OLD.workspace_id;
END;
INSERT INTO sync_pending_deletes(id,workspace_id,user_id,deadline,created_at,updated_at)
 SELECT id,workspace_id,user_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)+8000,unixepoch()*1000,unixepoch()*1000
 FROM threads WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
CREATE INDEX sync_transfers_event ON sync_transfers(workspace_id,event_id,direction);

-- Lifecycle acknowledgements are separate from record edit vectors. Copying ordinary parent
-- counters into edit vectors would falsely order unrelated edits when packets are reordered.
CREATE TRIGGER sync_capture_barriers AFTER INSERT ON sync_outbox BEGIN
 UPDATE sync_outbox SET barriers=(SELECT COALESCE(json_group_object(tag,json(vector)),'{}') FROM (
 SELECT tag,json_group_object(actor,counter) AS vector FROM (
 SELECT tag,actor,MAX(counter) AS counter FROM (
 SELECT '$workspace' AS tag,w.key AS actor,w.value AS counter FROM json_each((SELECT wipe_version FROM sync_state WHERE workspace_id=NEW.workspace_id)) w
 UNION ALL
 SELECT b.key AS tag,v.key AS actor,v.value AS counter FROM sync_records m,json_each(m.barriers) b,json_each(b.value) v WHERE m.workspace_id=NEW.workspace_id AND m.table_name=NEW.table_name AND m.record_key=NEW.record_key
 UNION ALL
 SELECT b.key AS tag,v.key AS actor,v.value AS counter FROM sync_reference_rules r JOIN json_each(NEW.payload) j ON j.key=r.column_name JOIN sync_entities e ON e.workspace_id=NEW.workspace_id AND e.table_name=r.parent_table AND e.original_id=j.value JOIN sync_records m ON m.workspace_id=e.workspace_id AND m.table_name=e.table_name AND m.record_key=e.record_key,json_each(m.barriers) b,json_each(b.value) v WHERE r.table_name=NEW.table_name
 UNION ALL
 SELECT t.table_name||':'||t.record_key AS tag,v.key AS actor,v.value AS counter FROM sync_reference_rules r JOIN json_each(NEW.payload) j ON j.key=r.column_name JOIN sync_entities e ON e.workspace_id=NEW.workspace_id AND e.table_name=r.parent_table AND e.original_id=j.value JOIN sync_records m ON m.workspace_id=e.workspace_id AND m.table_name=e.table_name AND m.record_key=e.record_key JOIN sync_tombstones t ON t.workspace_id=m.workspace_id AND t.table_name=m.table_name AND t.record_key=m.record_key,json_each(t.version) v WHERE r.table_name=NEW.table_name AND m.operation='put' AND NOT EXISTS(SELECT 1 FROM json_each(t.version) d WHERE COALESCE(json_extract(m.version,'$."'||d.key||'"'),0)<d.value)
 UNION ALL
 SELECT t.table_name||':'||t.record_key AS tag,v.key AS actor,v.value AS counter FROM sync_tombstones t,json_each(t.version) v WHERE t.workspace_id=NEW.workspace_id AND t.table_name=NEW.table_name AND t.record_key=NEW.record_key AND NOT EXISTS(SELECT 1 FROM json_each(t.version) d WHERE COALESCE(json_extract(NEW.version,'$."'||d.key||'"'),0)<d.value)
 ) GROUP BY tag,actor
 ) GROUP BY tag
 )) WHERE id=NEW.id;
END;
CREATE TABLE sync_policy_joins (
 workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,record_key TEXT NOT NULL,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,record_key)
);

CREATE TRIGGER sync_message_delete_deadline AFTER UPDATE OF deleted_at ON messages
 WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL BEGIN
 INSERT INTO sync_pending_deletes(id,workspace_id,user_id,table_name,deadline,created_at,updated_at)
 VALUES(NEW.id,NEW.workspace_id,NEW.user_id,'messages',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)+8000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(table_name,id) DO UPDATE SET deadline=excluded.deadline,updated_at=excluded.updated_at;
END;
CREATE TRIGGER sync_message_delete_undone AFTER UPDATE OF deleted_at ON messages WHEN NEW.deleted_at IS NULL BEGIN
 DELETE FROM sync_pending_deletes WHERE table_name='messages' AND id=NEW.id;
END;
CREATE TRIGGER sync_message_delete_finished AFTER DELETE ON messages BEGIN
 DELETE FROM sync_pending_deletes WHERE table_name='messages' AND id=OLD.id;
END;
INSERT INTO sync_pending_deletes(id,workspace_id,user_id,table_name,deadline,created_at,updated_at)
 SELECT id,workspace_id,user_id,'messages',CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)+8000,unixepoch()*1000,unixepoch()*1000 FROM messages WHERE deleted_at IS NOT NULL;
