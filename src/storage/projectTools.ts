/** Tools a project switched off (M9 step 1, AG-01). Every tool is on unless it's listed here. */
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export async function switchProjectTool(
  db: SqlDb,
  tenant: Tenant,
  projectId: string,
  tool: string,
  on: boolean,
): Promise<void> {
  if (on) {
    await db.execute(
      "DELETE FROM project_tools_off WHERE workspace_id = ? AND project_id = ? AND tool = ?",
      [tenant.workspaceId, projectId, tool],
    );
    return;
  }
  const now = Date.now();
  await db.execute(
    `INSERT OR IGNORE INTO project_tools_off (id, workspace_id, user_id, project_id, tool, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv7(now), tenant.workspaceId, tenant.userId, projectId, tool, now],
  );
}

/** The names of the tools the project switched off; none for a run outside a project. */
export async function projectToolsOff(
  db: SqlDb,
  tenant: Tenant,
  projectId: string | null,
): Promise<Set<string>> {
  if (!projectId) return new Set();
  const rows = await db.select<{ tool: string }>(
    "SELECT tool FROM project_tools_off WHERE workspace_id = ? AND project_id = ?",
    [tenant.workspaceId, projectId],
  );
  return new Set(rows.map((r) => r.tool));
}
