import type { SqlDb } from "@/storage/sql";
import type { Tenant } from "@/storage/defaults";
import type { ParallelChildView, ParallelView } from "./types";

/** Read-only progress works for portable child history as well as the execution owner. */
export async function parallelProgress(db: SqlDb, tenant: Tenant, parents: readonly string[]) {
  const result = new Map<string, ParallelView>();
  if (!parents.length) return result;
  const marks = parents.map(() => "?").join(",");
  const roots = await db.select<{ id: string; spent: number; cap: number; held: number }>(
    `SELECT r.id,r.spent_micro_usd AS spent,r.cap_micro_usd AS cap,
      COALESCE((SELECT SUM(MAX(h.bound_micro_usd-COALESCE(l.cost_micro_usd,0),0))
       FROM request_reservations h JOIN runs leaf ON leaf.id=h.run_id AND leaf.workspace_id=h.workspace_id
       LEFT JOIN request_log l ON l.id=h.request_id AND l.workspace_id=h.workspace_id
       WHERE h.workspace_id=r.workspace_id AND h.user_id=r.user_id AND h.state IN('held','dispatched','unknown')
       AND (leaf.id=r.id OR leaf.parent_run_id=r.id)),0) AS held
      FROM runs r WHERE r.workspace_id=? AND r.user_id=? AND r.parent_run_id IS NULL AND r.id IN(${marks})`,
    [tenant.workspaceId, tenant.userId, ...parents],
  );
  const rows = await db.select<ParallelChildView & { parentId: string }>(
    `SELECT r.id,r.parent_run_id AS parentId,r.task,r.status,r.branch,r.plan,r.planner,r.spent_micro_usd AS spentMicroUsd,r.note,
      (SELECT COUNT(*) FROM run_steps s WHERE s.run_id=r.id AND s.workspace_id=r.workspace_id) AS steps,
      (SELECT CASE WHEN s.kind='tool' THEN s.tool_name ELSE substr(s.text,1,500) END FROM run_steps s
       WHERE s.run_id=r.id AND s.workspace_id=r.workspace_id ORDER BY seq DESC LIMIT 1) AS latest
      FROM runs r JOIN runs p ON p.id=r.parent_run_id AND p.workspace_id=r.workspace_id AND p.user_id=r.user_id
      LEFT JOIN code_children c ON c.child_id=r.id AND c.workspace_id=r.workspace_id
      WHERE r.workspace_id=? AND r.user_id=? AND r.parent_run_id IN(${marks}) AND r.project_id IS p.project_id AND r.thread_id IS p.thread_id
      ORDER BY r.parent_run_id,COALESCE(c.ordinal,99),r.created_at,r.id LIMIT 300`,
    [tenant.workspaceId, tenant.userId, ...parents],
  );
  for (const row of rows) {
    const root = roots.find((r) => r.id === row.parentId);
    if (!root) continue;
    let view = result.get(row.parentId);
    if (!view) {
      view = {
        children: [],
        spentMicroUsd: root.spent,
        heldMicroUsd: root.held,
        capMicroUsd: root.cap,
      };
      result.set(root.id, view);
    }
    const prefix = row.task.includes("Child task approved through the parent run.")
      ? row.task.indexOf("\n\n")
      : -1;
    view.children.push({ ...row, task: prefix < 0 ? row.task : row.task.slice(prefix + 2) });
  }
  return result;
}

/** Stop is a conditional durable owner write; a stale tab cannot change a foreign replica. */
export async function stopParallelChild(
  db: SqlDb,
  tenant: Tenant,
  parentId: string,
  childId: string,
): Promise<boolean> {
  const stopped = await db.execute(
    `UPDATE runs AS c SET status='stopped',note='Stopped by the owner. Worktree and billing evidence are retained.',updated_at=?
      WHERE c.workspace_id=? AND c.user_id=? AND c.id=? AND c.parent_run_id=? AND c.status='running'
      AND (c.sync_owner IS NULL OR c.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=c.workspace_id))
      AND EXISTS(SELECT 1 FROM runs p WHERE p.id=c.parent_run_id AND p.workspace_id=c.workspace_id AND p.user_id=c.user_id
        AND p.parent_run_id IS NULL AND p.project_id IS c.project_id AND p.thread_id IS c.thread_id
        AND (p.sync_owner IS NULL OR p.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=p.workspace_id)))`,
    [Date.now(), tenant.workspaceId, tenant.userId, childId, parentId],
  );
  return stopped.rowsAffected === 1;
}
