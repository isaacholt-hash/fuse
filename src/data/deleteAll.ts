/**
 * Delete everything (SE-07): every row of this workspace's data, in an order the foreign keys
 * allow, and every stored attachment. The workspace and user rows stay so the app opens empty.
 * Keys live in the OS keychain and are removed separately, only when asked.
 */
import type { FilesApi } from "@/files/api";
import type { Tenant } from "@/storage/defaults";
import type { SqlDb } from "@/storage/sql";

/** Children before parents. */
export const DELETE_ORDER = [
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

export async function deleteAllData(
  db: SqlDb,
  tenant: Tenant,
  files: FilesApi,
): Promise<{ rows: number; files: number }> {
  const ws = tenant.workspaceId;
  // Threads point at messages (their active leaf); unhook that first.
  await db.execute(`UPDATE threads SET active_leaf_id = NULL WHERE workspace_id = ?`, [ws]);
  let rows = 0;
  for (const table of DELETE_ORDER) {
    rows += (await db.execute(`DELETE FROM ${table} WHERE workspace_id = ?`, [ws])).rowsAffected;
  }
  return { rows, files: files.wipe ? await files.wipe() : 0 };
}
