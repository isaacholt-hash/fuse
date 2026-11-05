-- M13.2: add the transcription purpose without changing existing receipts or references.
-- Migrations run with foreign keys disabled and validate every reference before opening.
ALTER TABLE request_reservations ADD COLUMN source_scope TEXT CHECK(source_scope IS NULL OR json_valid(source_scope));
ALTER TABLE request_reservations ADD COLUMN audio_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK(audio_duration_ms>=0);
ALTER TABLE request_reservations ADD COLUMN surface TEXT CHECK(surface IS NULL OR surface IN ('desktop','web'));
DROP TRIGGER request_log_project_privacy;
DROP TRIGGER sync_request_log_delete;
DROP TRIGGER sync_request_log_insert;
DROP TRIGGER sync_request_log_update;
CREATE TABLE request_log_new (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  user_id             TEXT NOT NULL REFERENCES users(id),
  thread_id           TEXT REFERENCES threads(id),
  message_id          TEXT, -- no FK: messages reference request_log too; set after both rows exist
  purpose             TEXT NOT NULL CHECK (purpose IN
                        ('chat', 'key_test', 'title', 'classify', 'memory', 'summary', 'embed', 'agent', 'transcribe')),
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  attempt             INTEGER NOT NULL DEFAULT 1,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd      INTEGER NOT NULL DEFAULT 0,
  price_version       TEXT,
  latency_ms          INTEGER,
  ttft_ms             INTEGER,
  http_status         INTEGER,
  error_code          TEXT,
  error_message       TEXT,
  provider_request_id TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  web_search_calls    INTEGER NOT NULL DEFAULT 0,
  tier                TEXT,
  route_rule_id       TEXT
, surface TEXT
  CHECK (surface IS NULL OR surface IN ('desktop', 'web', 'runner')), project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, audio_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK(audio_duration_ms>=0), billing_state TEXT NOT NULL DEFAULT 'legacy' CHECK(billing_state IN ('legacy','reported','estimated','unknown','not_billed')), attempt_id TEXT);
INSERT INTO request_log_new(id,workspace_id,user_id,thread_id,message_id,purpose,provider,model,attempt,input_tokens,output_tokens,cached_input_tokens,cache_write_tokens,reasoning_tokens,cost_micro_usd,price_version,latency_ms,ttft_ms,http_status,error_code,error_message,provider_request_id,created_at,updated_at,web_search_calls,tier,route_rule_id,surface,project_id,audio_duration_ms,billing_state,attempt_id) SELECT id,workspace_id,user_id,thread_id,message_id,purpose,provider,model,attempt,input_tokens,output_tokens,cached_input_tokens,cache_write_tokens,reasoning_tokens,cost_micro_usd,price_version,latency_ms,ttft_ms,http_status,error_code,error_message,provider_request_id,created_at,updated_at,web_search_calls,tier,route_rule_id,surface,project_id,audio_duration_ms,billing_state,attempt_id FROM request_log;
DROP TABLE request_log;
ALTER TABLE request_log_new RENAME TO request_log;
CREATE UNIQUE INDEX request_log_attempt ON request_log(workspace_id,attempt_id) WHERE attempt_id IS NOT NULL;

CREATE INDEX request_log_recent ON request_log (workspace_id, created_at DESC);

CREATE TRIGGER request_log_project_privacy AFTER UPDATE OF privacy_mode ON projects
WHEN NEW.privacy_mode IS NOT OLD.privacy_mode BEGIN
 UPDATE request_log SET updated_at=MAX(updated_at+1,unixepoch()*1000)
 WHERE workspace_id=NEW.workspace_id AND project_id=NEW.id;
END;

CREATE TRIGGER sync_request_log_delete AFTER DELETE ON request_log
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=OLD.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND (EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='request_log' AND record_key=OLD.id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,OLD.workspace_id,OLD.user_id,'request_log',OLD.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='request_log' AND record_key=OLD.id),'{}'),'$."'||device_id||'"',seq),
 'delete',CASE WHEN ('delete')='put' THEN json_object('id',OLD.id,'workspace_id',OLD.workspace_id,'user_id',OLD.user_id,'thread_id',OLD.thread_id,'message_id',OLD.message_id,'purpose',OLD.purpose,'provider',OLD.provider,'model',OLD.model,'attempt',OLD.attempt,'input_tokens',OLD.input_tokens,'output_tokens',OLD.output_tokens,'cached_input_tokens',OLD.cached_input_tokens,'cache_write_tokens',OLD.cache_write_tokens,'reasoning_tokens',OLD.reasoning_tokens,'cost_micro_usd',OLD.cost_micro_usd,'price_version',OLD.price_version,'latency_ms',OLD.latency_ms,'ttft_ms',OLD.ttft_ms,'http_status',OLD.http_status,'error_code',OLD.error_code,'error_message',OLD.error_message,'provider_request_id',OLD.provider_request_id,'created_at',OLD.created_at,'updated_at',OLD.updated_at,'web_search_calls',OLD.web_search_calls,'tier',OLD.tier,'route_rule_id',OLD.route_rule_id,'surface',OLD.surface,'project_id',OLD.project_id,'audio_duration_ms',OLD.audio_duration_ms,'billing_state',OLD.billing_state,'attempt_id',OLD.attempt_id) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=OLD.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='request_log' AND record_key=OLD.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=OLD.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=OLD.workspace_id AND table_name='request_log' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=OLD.workspace_id AND table_name='request_log' AND operation!='put');
 END;

CREATE TRIGGER sync_request_log_insert AFTER INSERT ON request_log
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((((1) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))))) AND (NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND record_key=NEW.id)))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'request_log',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (((1) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))))) AND (NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (((1) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))))) AND (NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'thread_id',NEW.thread_id,'message_id',NEW.message_id,'purpose',NEW.purpose,'provider',NEW.provider,'model',NEW.model,'attempt',NEW.attempt,'input_tokens',NEW.input_tokens,'output_tokens',NEW.output_tokens,'cached_input_tokens',NEW.cached_input_tokens,'cache_write_tokens',NEW.cache_write_tokens,'reasoning_tokens',NEW.reasoning_tokens,'cost_micro_usd',NEW.cost_micro_usd,'price_version',NEW.price_version,'latency_ms',NEW.latency_ms,'ttft_ms',NEW.ttft_ms,'http_status',NEW.http_status,'error_code',NEW.error_code,'error_message',NEW.error_message,'provider_request_id',NEW.provider_request_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'web_search_calls',NEW.web_search_calls,'tier',NEW.tier,'route_rule_id',NEW.route_rule_id,'surface',NEW.surface,'project_id',NEW.project_id,'audio_duration_ms',NEW.audio_duration_ms,'billing_state',NEW.billing_state,'attempt_id',NEW.attempt_id) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND operation!='put');
 END;

CREATE TRIGGER sync_request_log_update AFTER UPDATE ON request_log
 WHEN EXISTS (SELECT 1 FROM sync_state WHERE workspace_id=NEW.workspace_id AND (enabled=1 OR epoch>0) AND applying=0) AND ((1) AND ((((1) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))))) AND (NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) OR EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND record_key=NEW.id))) AND ((SELECT force_capture FROM sync_state WHERE workspace_id=NEW.workspace_id)=1 OR NOT EXISTS (SELECT 1 FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND record_key=NEW.id) OR (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.user_id IS NOT OLD.user_id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.message_id IS NOT OLD.message_id OR NEW.purpose IS NOT OLD.purpose OR NEW.provider IS NOT OLD.provider OR NEW.model IS NOT OLD.model OR NEW.attempt IS NOT OLD.attempt OR NEW.input_tokens IS NOT OLD.input_tokens OR NEW.output_tokens IS NOT OLD.output_tokens OR NEW.cached_input_tokens IS NOT OLD.cached_input_tokens OR NEW.cache_write_tokens IS NOT OLD.cache_write_tokens OR NEW.reasoning_tokens IS NOT OLD.reasoning_tokens OR NEW.cost_micro_usd IS NOT OLD.cost_micro_usd OR NEW.price_version IS NOT OLD.price_version OR NEW.latency_ms IS NOT OLD.latency_ms OR NEW.ttft_ms IS NOT OLD.ttft_ms OR NEW.http_status IS NOT OLD.http_status OR NEW.error_code IS NOT OLD.error_code OR NEW.error_message IS NOT OLD.error_message OR NEW.provider_request_id IS NOT OLD.provider_request_id OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.web_search_calls IS NOT OLD.web_search_calls OR NEW.tier IS NOT OLD.tier OR NEW.route_rule_id IS NOT OLD.route_rule_id OR NEW.surface IS NOT OLD.surface OR NEW.project_id IS NOT OLD.project_id OR NEW.audio_duration_ms IS NOT OLD.audio_duration_ms OR NEW.billing_state IS NOT OLD.billing_state OR NEW.attempt_id IS NOT OLD.attempt_id))
 BEGIN
 UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_outbox (id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
 SELECT device_id||':'||seq,NEW.workspace_id,NEW.user_id,'request_log',NEW.id,device_id,seq,clock,
 json_set(COALESCE((SELECT version FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND record_key=NEW.id),'{}'),'$."'||device_id||'"',seq),
 CASE WHEN NOT (((1) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))))) AND (NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END,CASE WHEN (CASE WHEN NOT (((1) AND (NEW.thread_id IS NULL OR (EXISTS (SELECT 1 FROM threads t WHERE t.id=NEW.thread_id AND t.workspace_id=NEW.workspace_id AND t.incognito=0 AND t.local_only=0 AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.privacy_mode!='local_only')))))) AND (NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.workspace_id=NEW.workspace_id AND p.privacy_mode!='local_only'))) THEN 'withdraw' ELSE 'put' END)='put' THEN json_object('id',NEW.id,'workspace_id',NEW.workspace_id,'user_id',NEW.user_id,'thread_id',NEW.thread_id,'message_id',NEW.message_id,'purpose',NEW.purpose,'provider',NEW.provider,'model',NEW.model,'attempt',NEW.attempt,'input_tokens',NEW.input_tokens,'output_tokens',NEW.output_tokens,'cached_input_tokens',NEW.cached_input_tokens,'cache_write_tokens',NEW.cache_write_tokens,'reasoning_tokens',NEW.reasoning_tokens,'cost_micro_usd',NEW.cost_micro_usd,'price_version',NEW.price_version,'latency_ms',NEW.latency_ms,'ttft_ms',NEW.ttft_ms,'http_status',NEW.http_status,'error_code',NEW.error_code,'error_message',NEW.error_message,'provider_request_id',NEW.provider_request_id,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'web_search_calls',NEW.web_search_calls,'tier',NEW.tier,'route_rule_id',NEW.route_rule_id,'surface',NEW.surface,'project_id',NEW.project_id,'audio_duration_ms',NEW.audio_duration_ms,'billing_state',NEW.billing_state,'attempt_id',NEW.attempt_id) ELSE NULL END,unixepoch()*1000,unixepoch()*1000 FROM sync_state WHERE workspace_id=NEW.workspace_id;
 INSERT INTO sync_records (workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at)
 SELECT workspace_id,user_id,table_name,record_key,id,device_id,clock,version,
 COALESCE((SELECT revision FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND record_key=NEW.id),0)+1,operation,created_at,updated_at
 FROM sync_outbox WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=NEW.workspace_id)
 ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET
 event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,
 revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at;
 DELETE FROM sync_outbox WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND operation='put' AND record_key IN (SELECT record_key FROM sync_records WHERE workspace_id=NEW.workspace_id AND table_name='request_log' AND operation!='put');
 END;
