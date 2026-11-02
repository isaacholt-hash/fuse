// M10 step 18 (delete for real): the startup sweep. A delete marks rows first (the undo toast),
// then purges them when the toast ends; whatever was still only marked when the app closed or
// crashed is purged here, so every delete ends real.
import type { Tenant } from "./defaults";
import { purgeMessages } from "./messages";
import type { SqlDb } from "./sql";
import { purgeThread } from "./threads";

/**
 * Purges every chat and message that was deleted but not yet purged. Incognito chats go
 * entirely; the rest keep their tombstone (project and kind, for spend totals). Returns how
 * many of each it purged.
 */
export async function sweepDeleted(
  db: SqlDb,
  tenant: Tenant,
): Promise<{ threads: number; messages: number }> {
  const ws = tenant.workspaceId;
  const threads = await db.select<{ id: string; incognito: number }>(
    `SELECT id, incognito FROM threads
     WHERE workspace_id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL`,
    [ws],
  );
  for (const t of threads) {
    await purgeThread(db, tenant, t.id, t.incognito ? "nothing" : "tombstone");
  }
  // Deleted messages whose subtree is deleted too (a live child would keep the row, since the
  // foreign keys are enforced; such a child only comes from an undo, which also restores the parent).
  const messages = await db.select<{ id: string }>(
    `SELECT id FROM messages m
     WHERE m.workspace_id = ? AND m.deleted_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM messages c WHERE c.deleted_at IS NULL
                       AND (c.parent_id = m.id OR c.escalated_from_id = m.id))`,
    [ws],
  );
  await purgeMessages(
    db,
    tenant,
    messages.map((m) => m.id),
  );
  return { threads: threads.length, messages: messages.length };
}
