-- Named packages contain inert, bounded app-managed assets, never installation grants.
CREATE TABLE skills (
 id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
 name TEXT NOT NULL, sync_local_only INTEGER NOT NULL DEFAULT 0 CHECK(sync_local_only IN(0,1)),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE skill_versions (
 id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id TEXT NOT NULL REFERENCES users(id), skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
 instructions TEXT NOT NULL CHECK(length(instructions)<=32768),
 assets TEXT NOT NULL CHECK(json_valid(assets) AND length(assets)<=3000000),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64), source TEXT NOT NULL CHECK(length(source)<=100),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX skills_scope ON skills(workspace_id,user_id,project_id,name,id);
CREATE INDEX skill_versions_order ON skill_versions(workspace_id,skill_id,created_at,id);
-- Force-capture may touch a row, but cannot rewrite an immutable version's content.
CREATE TRIGGER skill_version_immutable BEFORE UPDATE ON skill_versions
 WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id
 OR NEW.skill_id IS NOT OLD.skill_id OR NEW.instructions IS NOT OLD.instructions OR NEW.assets IS NOT OLD.assets
 OR NEW.sha256 IS NOT OLD.sha256 OR NEW.source IS NOT OLD.source OR NEW.created_at IS NOT OLD.created_at
 BEGIN SELECT RAISE(ABORT,'Skill versions are immutable; import another version'); END;
INSERT INTO sync_reference_rules(table_name,column_name,parent_table,target,parent_has_id) VALUES
 ('skills','project_id','projects','id',1),('skill_versions','skill_id','skills','id',1);

CREATE TRIGGER sync_skills_insert AFTER INSERT ON skills
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((NEW.sync_local_only=0 AND (NEW.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skills' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'skills',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skills' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (NEW.sync_local_only=0 AND (NEW.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (NEW.sync_local_only=0 AND (NEW.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'project_id',NEW.project_id,'name',NEW.name,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skills' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='skills' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skills' AND operation!='put');
 END;
CREATE TRIGGER sync_skills_update AFTER UPDATE ON skills
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((NEW.sync_local_only=0 AND (NEW.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skills' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skills' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.project_id IS NOT OLD.project_id OR NEW.name IS NOT OLD.name OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.sync_local_only IS NOT OLD.sync_local_only))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'skills',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skills' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (NEW.sync_local_only=0 AND (NEW.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (NEW.sync_local_only=0 AND (NEW.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'project_id',NEW.project_id,'name',NEW.name,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skills' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='skills' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skills' AND operation!='put');
 END;
CREATE TRIGGER sync_skills_delete AFTER DELETE ON skills
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='skills' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'skills',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='skills' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'project_id',OLD.project_id,'name',OLD.name,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='skills' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='skills' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='skills' AND operation!='put');
 END;

CREATE TRIGGER sync_skill_versions_insert AFTER INSERT ON skill_versions
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS(SELECT 1 FROM skills s WHERE s.id=NEW.skill_id AND s.workspace_id=NEW.workspace_id AND s.sync_local_only=0 AND (s.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=s.project_id AND p.workspace_id=s.workspace_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skill_versions' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'skill_versions',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skill_versions' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS(SELECT 1 FROM skills s WHERE s.id=NEW.skill_id AND s.workspace_id=NEW.workspace_id AND s.sync_local_only=0 AND (s.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=s.project_id AND p.workspace_id=s.workspace_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS(SELECT 1 FROM skills s WHERE s.id=NEW.skill_id AND s.workspace_id=NEW.workspace_id AND s.sync_local_only=0 AND (s.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=s.project_id AND p.workspace_id=s.workspace_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'skill_id',NEW.skill_id,'instructions',NEW.instructions,'assets',NEW.assets,'sha256',NEW.sha256,'source',NEW.source,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skill_versions' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='skill_versions' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skill_versions' AND operation!='put');
 END;
CREATE TRIGGER sync_skill_versions_update AFTER UPDATE ON skill_versions
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((EXISTS(SELECT 1 FROM skills s WHERE s.id=NEW.skill_id AND s.workspace_id=NEW.workspace_id AND s.sync_local_only=0 AND (s.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=s.project_id AND p.workspace_id=s.workspace_id AND p.privacy_mode!='local_only')))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skill_versions' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skill_versions' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.skill_id IS NOT OLD.skill_id OR NEW.instructions IS NOT OLD.instructions OR NEW.assets IS NOT OLD.assets OR NEW.sha256 IS NOT OLD.sha256 OR NEW.source IS NOT OLD.source OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'skill_versions',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skill_versions' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (EXISTS(SELECT 1 FROM skills s WHERE s.id=NEW.skill_id AND s.workspace_id=NEW.workspace_id AND s.sync_local_only=0 AND (s.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=s.project_id AND p.workspace_id=s.workspace_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (EXISTS(SELECT 1 FROM skills s WHERE s.id=NEW.skill_id AND s.workspace_id=NEW.workspace_id AND s.sync_local_only=0 AND (s.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=s.project_id AND p.workspace_id=s.workspace_id AND p.privacy_mode!='local_only')))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'skill_id',NEW.skill_id,'instructions',NEW.instructions,'assets',NEW.assets,'sha256',NEW.sha256,'source',NEW.source,'created_at',NEW.created_at,'updated_at',NEW.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skill_versions' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='skill_versions' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='skill_versions' AND operation!='put');
 END;
CREATE TRIGGER sync_skill_versions_delete AFTER DELETE ON skill_versions
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='skill_versions' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'skill_versions',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='skill_versions' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'skill_id',OLD.skill_id,'instructions',OLD.instructions,'assets',OLD.assets,'sha256',OLD.sha256,'source',OLD.source,'created_at',OLD.created_at,'updated_at',OLD.updated_at) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='skill_versions' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='skill_versions' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='skill_versions' AND operation!='put');
 END;
