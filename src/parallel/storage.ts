import type { Tenant } from "@/storage/defaults";
import type { SqlDb } from "@/storage/sql";
import { addToolStep } from "@/storage/runs";
import { childTasks } from "./tool";

/** Startup only. Ready work was never sent; running work may be billed. Neither is replayed. */
export async function interruptChildren(db: SqlDb, tenant: Tenant): Promise<void> {
  const scope = `workspace_id=? AND user_id=? AND state IN ('creating','ready','running')
    AND EXISTS(SELECT 1 FROM runs p WHERE p.id=code_children.parent_id AND p.workspace_id=code_children.workspace_id
    AND (p.sync_owner IS NULL OR p.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=p.workspace_id)))`;
  const now = Date.now();
  await db.batch([
    {
      sql: `UPDATE runs SET status='stopped',note='FUSE stopped during child execution. Its worktree and billing evidence are retained.',updated_at=?
      WHERE workspace_id=? AND user_id=? AND id IN(SELECT child_id FROM code_children WHERE ${scope})`,
      params: [now, tenant.workspaceId, tenant.userId, tenant.workspaceId, tenant.userId],
    },
    {
      sql: `UPDATE code_children SET state='interrupted',updated_at=? WHERE ${scope}`,
      params: [now, tenant.workspaceId, tenant.userId],
    },
  ]);
}

/** Fill only a lost delegation result on explicit parent continuation. Execute no child. */
export async function recoverChildResults(
  db: SqlDb,
  tenant: Tenant,
  parentId: string,
): Promise<void> {
  const groups = await db.select<{ call_id: string; request: string }>(
    `SELECT DISTINCT c.call_id,c.request FROM code_children c WHERE c.workspace_id=? AND c.user_id=? AND c.parent_id=?
      AND NOT EXISTS(SELECT 1 FROM code_children active WHERE active.parent_id=c.parent_id AND active.dispatch_id=c.dispatch_id
        AND active.state IN ('creating','ready','running'))
      AND NOT EXISTS(SELECT 1 FROM run_steps s WHERE s.workspace_id=c.workspace_id AND s.run_id=c.parent_id AND s.kind='tool' AND s.tool_call_id=c.call_id)`,
    [tenant.workspaceId, tenant.userId, parentId],
  );
  for (const group of groups) {
    const parsed: unknown = JSON.parse(group.request);
    if (!parsed || typeof parsed !== "object" || !("tasks" in parsed))
      throw new Error(
        "Retained child preparation is malformed. Inspect the worktrees before continuing.",
      );
    const tasks = childTasks({ tasks: parsed.tasks });
    const children = await db.select<{ id: string; state: string }>(
      "SELECT child_id AS id,state FROM code_children WHERE workspace_id=? AND user_id=? AND parent_id=? AND call_id=? ORDER BY ordinal",
      [tenant.workspaceId, tenant.userId, parentId, group.call_id],
    );
    await addToolStep(db, tenant, parentId, {
      call: { id: group.call_id, name: "delegate_code", input: { tasks } },
      output: JSON.stringify({
        interrupted: true,
        replayed: false,
        integrated: false,
        children,
        note: "The execution owner stopped before recording this result. Review retained worktree changes and billing. No child is restarted by continuation.",
      }),
      isError: true,
      approval: "you",
    });
  }
}
