/** Where sandboxed commands may use the network (M8 step 10, WF-07): per chat or per folder. */
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export type NetworkScope = { kind: "thread" | "folder"; id: string };

export async function allowNetwork(db: SqlDb, tenant: Tenant, scope: NetworkScope): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT OR IGNORE INTO network_grants (id, workspace_id, user_id, scope_kind, scope_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv7(now), tenant.workspaceId, tenant.userId, scope.kind, scope.id, now],
  );
}

export async function disallowNetwork(
  db: SqlDb,
  tenant: Tenant,
  scope: NetworkScope,
): Promise<void> {
  await db.execute(
    "DELETE FROM network_grants WHERE workspace_id = ? AND scope_kind = ? AND scope_id = ?",
    [tenant.workspaceId, scope.kind, scope.id],
  );
}

/** Whether any of these scopes has the network. */
export async function networkAllowed(
  db: SqlDb,
  tenant: Tenant,
  scopes: readonly NetworkScope[],
): Promise<boolean> {
  if (scopes.length === 0) return false;
  const rows = await db.select<{ n: number }>(
    `SELECT COUNT(*) AS n FROM network_grants WHERE workspace_id = ? AND (${scopes
      .map(() => "(scope_kind = ? AND scope_id = ?)")
      .join(" OR ")})`,
    [tenant.workspaceId, ...scopes.flatMap((s) => [s.kind, s.id])],
  );
  return (rows[0]?.n ?? 0) > 0;
}

/** The folders allowed the network, by id. */
export async function networkFolders(db: SqlDb, tenant: Tenant): Promise<Set<string>> {
  const rows = await db.select<{ scope_id: string }>(
    "SELECT scope_id FROM network_grants WHERE workspace_id = ? AND scope_kind = 'folder'",
    [tenant.workspaceId],
  );
  return new Set(rows.map((r) => r.scope_id));
}

/**
 * Output that looks like a command was refused the network (DNS or connect errors from common
 * tools). Used only to offer to allow it; never to allow it by itself.
 */
export const NETWORK_FAILURE =
  /Network is unreachable|Temporary failure in name resolution|Could not resolve host|getaddrinfo (?:EAI_AGAIN|ENOTFOUND)|Name or service not known|network is unreachable|connect: (?:Network|Connection refused)|Failed to establish a new connection|ENETUNREACH|EAI_AGAIN|unable to access 'https?:\/\//;
