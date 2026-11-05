-- Review is a read-only Code profile, never a generic executable replica. Captured repository
-- bytes and in-flight request recovery belong only to the execution owner.
ALTER TABLE runs ADD COLUMN review_profile INTEGER NOT NULL DEFAULT 0 CHECK(review_profile IN (0,1));
CREATE TABLE review_state (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  data TEXT NOT NULL CHECK(json_valid(data)),
  lease TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE review_operations (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  run_id TEXT NOT NULL REFERENCES review_state(run_id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('plan','analysis','final')),
  state TEXT NOT NULL CHECK(state IN ('pending','complete','unknown','not_dispatched','discarded')),
  result TEXT CHECK(result IS NULL OR json_valid(result)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX review_operations_run ON review_operations(workspace_id,run_id,created_at,id);

DROP TRIGGER sync_runs_insert;
CREATE TRIGGER sync_runs_insert AFTER INSERT ON runs
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((NEW.status IN ('done','stopped','error')) AND ((((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'runs',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'project_id',NEW.project_id,'thread_id',NEW.thread_id,'message_id',NEW.message_id,'task',NEW.task,'kind',NEW.kind,'mode',NEW.mode,'provider',NEW.provider,'model',NEW.model,'status',NEW.status,'cap_micro_usd',NEW.cap_micro_usd,'spent_micro_usd',NEW.spent_micro_usd,'note',NEW.note,'summary',NEW.summary,'summary_upto',NEW.summary_upto,'branch',NEW.branch,'plan',NEW.plan,'planner',NEW.planner,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'started_at',NEW.started_at,'waited_ms',NEW.waited_ms,'review_profile',NEW.review_profile) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
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
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((NEW.status IN ('done','stopped','error')) AND ((((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.project_id IS NOT OLD.project_id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.message_id IS NOT OLD.message_id OR NEW.task IS NOT OLD.task OR NEW.kind IS NOT OLD.kind OR NEW.mode IS NOT OLD.mode OR NEW.provider IS NOT OLD.provider OR NEW.model IS NOT OLD.model OR NEW.status IS NOT OLD.status OR NEW.cap_micro_usd IS NOT OLD.cap_micro_usd OR NEW.spent_micro_usd IS NOT OLD.spent_micro_usd OR NEW.note IS NOT OLD.note OR NEW.summary IS NOT OLD.summary OR NEW.summary_upto IS NOT OLD.summary_upto OR NEW.branch IS NOT OLD.branch OR NEW.plan IS NOT OLD.plan OR NEW.planner IS NOT OLD.planner OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.started_at IS NOT OLD.started_at OR NEW.waited_ms IS NOT OLD.waited_ms OR NEW.review_profile IS NOT OLD.review_profile))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'runs',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (((NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) AND (NEW.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only'))))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'project_id',NEW.project_id,'thread_id',NEW.thread_id,'message_id',NEW.message_id,'task',NEW.task,'kind',NEW.kind,'mode',NEW.mode,'provider',NEW.provider,'model',NEW.model,'status',NEW.status,'cap_micro_usd',NEW.cap_micro_usd,'spent_micro_usd',NEW.spent_micro_usd,'note',NEW.note,'summary',NEW.summary,'summary_upto',NEW.summary_upto,'branch',NEW.branch,'plan',NEW.plan,'planner',NEW.planner,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'started_at',NEW.started_at,'waited_ms',NEW.waited_ms,'review_profile',NEW.review_profile) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='runs' AND operation!='put');
 END;
