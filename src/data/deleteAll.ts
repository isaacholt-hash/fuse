/**
 * Delete everything (SE-07): every row of this workspace's data, in an order the foreign keys
 * allow, and every stored attachment. The workspace and user rows stay so the app opens empty.
 * Keys live in the OS keychain and are removed separately, only when asked.
 */
import type { FilesApi } from "@/files/api";
import type { Tenant } from "@/storage/defaults";
import type { SqlDb, SqlStatement } from "@/storage/sql";

/** Children before parents. */
export const DELETE_ORDER = [
  "code_child_reviews",
  "code_children",
  "skill_script_claims",
  "skill_versions",
  "skills",
  "review_operations",
  "review_state",
  "research_transfers",
  "research_operations",
  "research_state",
  "request_reservations",
  "sync_prepared",
  "sync_transfers",
  "sync_unavailable",
  "sync_pending_deletes",
  "sync_policy_joins",
  "sync_revisions",
  "sync_conflicts",
  "sync_inbox",
  // M10: scheduled tasks, what pages asked the runner, and its questions and streaming text,
  // before runs.
  "schedules",
  "run_requests",
  "run_approvals",
  "run_live",
  // Coding runs (M6): changes and steps before their run, runs before their messages.
  "run_changes",
  "run_folders",
  "run_steps",
  "runs",
  "project_commands",
  // M8: folder links before what they link.
  "folder_files",
  "thread_folders",
  "project_folders",
  "folders",
  // M7: shadow checks and the response cache.
  "local_shadow",
  "network_grants",
  "project_tools_off",
  "project_mcp_servers",
  "connector_accounts",
  "mcp_servers",
  "response_cache",
  "chunk_vectors",
  "chunks",
  "message_citations",
  "message_files",
  "message_memories",
  "budget_events",
  "budgets",
  "artifact_versions",
  "artifacts",
  "thread_summaries",
  "web_pages",
  "project_files",
  "memory_proposals",
  "memories",
  "golden_prompts",
  "user_instructions",
  "settings",
  "imports",
  "thread_tags",
  "prompts",
  "egress_rules",
  "messages",
  "request_log",
  "files",
  "threads",
  "projects",
  "security_audit",
] as const;

/** Content-free sync identity/causality must survive a wipe so deletion can propagate. */
export const SYNC_KEPT_ON_DELETE = [
  "sync_state",
  "sync_records",
  "sync_outbox",
  "sync_tombstones",
  "sync_devices",
  "sync_relay",
  "sync_receipts",
  "sync_blobs",
  "sync_aliases",
  "sync_entities",
  "sync_lineage",
  "sync_blob_refs",
  "sync_seen",
  "sync_reference_rules",
  "sync_releases",
] as const;

export async function deleteAllData(
  db: SqlDb,
  tenant: Tenant,
  files: FilesApi,
): Promise<{ rows: number; files: number }> {
  const ws = tenant.workspaceId;
  // Threads point at messages (their active leaf); unhook that first.
  const statements: SqlStatement[] = [
    {
      sql: `UPDATE threads SET active_leaf_id = NULL WHERE workspace_id = ?`,
      params: [ws],
    },
  ];
  statements.push({
    sql: "INSERT INTO sync_releases(id,workspace_id,user_id,created_at,updated_at) SELECT DISTINCT blob_id,workspace_id,user_id,?,? FROM sync_blob_refs WHERE workspace_id=? ON CONFLICT DO NOTHING",
    params: [Date.now(), Date.now(), ws],
  });
  statements.push({ sql: "DELETE FROM sync_blob_refs WHERE workspace_id=?", params: [ws] });
  statements.push({
    sql: "DELETE FROM sync_relay WHERE workspace_id=? AND (operation='put' OR operation IS NULL)",
    params: [ws],
  });
  for (const table of DELETE_ORDER) {
    statements.push({ sql: `DELETE FROM ${table} WHERE workspace_id = ?`, params: [ws] });
  }
  // A workspace barrier also covers offline records this installation has never seen.
  // Capture it atomically with the wipe, and only after explicit prior enrollment.
  statements.push(
    {
      sql: "UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=? AND user_id=? AND epoch>0",
      params: [ws, tenant.userId],
    },
    {
      sql: `INSERT INTO sync_outbox(id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at)
      SELECT device_id||':'||seq,workspace_id,user_id,'$workspace',workspace_id,device_id,seq,clock,
      json_set(wipe_version,'$."'||device_id||'"',seq),'delete',NULL,?,? FROM sync_state WHERE workspace_id=? AND user_id=? AND epoch>0`,
      params: [Date.now(), Date.now(), ws, tenant.userId],
    },
    {
      sql: "UPDATE sync_state SET wipe_version=(SELECT version FROM sync_outbox WHERE id=sync_state.device_id||':'||sync_state.seq) WHERE workspace_id=? AND user_id=? AND epoch>0",
      params: [ws, tenant.userId],
    },
  );
  const results = await db.batch(statements);
  const rows = results
    .slice(4, DELETE_ORDER.length + 4)
    .reduce((sum, row) => sum + row.rowsAffected, 0);
  return { rows, files: files.wipe ? await files.wipe() : 0 };
}
