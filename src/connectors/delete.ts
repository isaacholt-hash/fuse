/** Erase credentials while their installation-local registration metadata still exists.
 * A data-only deletion keeps native grants under the owner's existing credential choice. */
import type { SqlDb } from "@/storage/sql";
import type { Tenant } from "@/storage/defaults";
import type { ConnectorsApi } from "./api";
import type { McpApi } from "@/mcp/api";
import { listMcpServers } from "@/storage/mcp";
export async function prepareAccountDeletion(
  db: SqlDb,
  tenant: Tenant,
  removeCredentials: boolean,
  connectors: ConnectorsApi | undefined,
  mcp: Pick<McpApi, "removeSecret" | "signOut" | "stop"> | undefined,
): Promise<void> {
  await connectors?.prepareDelete(tenant, removeCredentials);
  if (!removeCredentials || !mcp) return;
  for (const server of await listMcpServers(db, tenant)) {
    for (const name of server.envNames) await mcp.removeSecret(server.id, name);
    if (server.transport === "http") await mcp.signOut?.(server.id);
    await mcp.stop?.(server.id);
  }
}
