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
  for (const table of DELETE_ORDER) {
    statements.push({ sql: `DELETE FROM ${table} WHERE workspace_id = ?`, params: [ws] });
  }
  const results = await db.batch(statements);
  const rows = results.slice(1).reduce((sum, row) => sum + row.rowsAffected, 0);
  return { rows, files: files.wipe ? await files.wipe() : 0 };
}
