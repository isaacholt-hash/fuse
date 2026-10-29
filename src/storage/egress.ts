import type { ProviderId } from "@/catalog/catalog";
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

/** SE-13: a provider allowed or blocked everywhere (`projectId` null) or in one project. */
export interface EgressRule {
  projectId: string | null;
  provider: ProviderId;
  allow: boolean;
}

export async function listEgressRules(db: SqlDb, tenant: Tenant): Promise<EgressRule[]> {
  const rows = await db.select<{ project_id: string | null; provider: ProviderId; allow: number }>(
    `SELECT project_id, provider, allow FROM egress_rules WHERE workspace_id = ?
     ORDER BY project_id, provider`,
    [tenant.workspaceId],
  );
  return rows.map((r) => ({ projectId: r.project_id, provider: r.provider, allow: r.allow === 1 }));
}

/** Sets a rule; `allow` null removes it (a project then follows the global rule). */
export async function setEgressRule(
  db: SqlDb,
  tenant: Tenant,
  projectId: string | null,
  provider: ProviderId,
  allow: boolean | null,
): Promise<void> {
  await db.execute(
    `DELETE FROM egress_rules WHERE workspace_id = ? AND COALESCE(project_id, '') = ? AND provider = ?`,
    [tenant.workspaceId, projectId ?? "", provider],
  );
  if (allow === null) return;
  const now = Date.now();
  await db.execute(
    `INSERT INTO egress_rules (id, workspace_id, user_id, project_id, provider, allow, created_at,
       updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv7(now), tenant.workspaceId, tenant.userId, projectId, provider, allow ? 1 : 0, now, now],
  );
}

/** SE-13 per record: a knowledge file kept on this device is never sent or embedded. */
export async function setFileMaySend(
  db: SqlDb,
  tenant: Tenant,
  fileId: string,
  maySend: boolean,
): Promise<void> {
  await db.execute(
    `UPDATE files SET may_send = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [maySend ? 1 : 0, Date.now(), tenant.workspaceId, fileId],
  );
}
