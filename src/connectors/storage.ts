/** Registration metadata only. All rows and MCP project permissions are installation-local. */
import type { SqlDb } from "@/storage/sql";
import type { Tenant } from "@/storage/defaults";
import type { ConnectorKind, ConnectorRegistration, ConnectorService } from "./api";
export async function listConnectorRegistrations(
  db: SqlDb,
  tenant: Tenant,
): Promise<ConnectorRegistration[]> {
  const rows = await db.select<{
    id: string;
    builtin_kind: ConnectorKind;
    client_id: string;
    tenant: string;
    services: string;
  }>(
    `SELECT a.id, s.builtin_kind, a.client_id, a.tenant, a.services
     FROM connector_accounts a JOIN mcp_servers s ON a.id=s.id
     AND a.workspace_id=s.workspace_id AND a.user_id=s.user_id
     WHERE a.workspace_id=? AND a.user_id=? AND s.deleted_at IS NULL AND s.builtin_kind IS NOT NULL
     ORDER BY s.name, a.created_at, a.id`,
    [tenant.workspaceId, tenant.userId],
  );
  return rows.map((r) => ({
    ...tenant,
    id: r.id,
    kind: r.builtin_kind,
    clientId: r.client_id,
    tenant: r.tenant,
    services: JSON.parse(r.services) as ConnectorService[],
  }));
}
