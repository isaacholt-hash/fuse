/**
 * MCP servers added in Settings (M9 step 8, AG-02): a local command (stdio) or a remote URL
 * (http). Their environment variables' values are in the OS keychain (src/mcp/api.ts); only the
 * names are here. Projects switch servers on for their chats and runs (step 9).
 */
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export type McpTransport = "stdio" | "http";

export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  /** stdio: the program, and its arguments. */
  command: string | null;
  args: string[];
  /** http: the server's address. */
  url: string | null;
  /** The variables it gets, by name; their values are in the keychain. */
  envNames: string[];
  /** A local server may use the network (it runs sandboxed without it otherwise). */
  network: boolean;
}

interface Row {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string;
  url: string | null;
  env_names: string;
  network: number;
}

const toServer = (r: Row): McpServer => ({
  id: r.id,
  name: r.name,
  transport: r.transport,
  command: r.command,
  args: JSON.parse(r.args) as string[],
  url: r.url,
  envNames: JSON.parse(r.env_names) as string[],
  network: r.network === 1,
});

/** A variable name a server can be given. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type NewMcpServer = Omit<McpServer, "id">;

/** Why a server can't be added as it is, or null. */
export function mcpServerProblem(s: NewMcpServer): string | null {
  if (!s.name.trim()) return "Give the server a name.";
  if (s.transport === "stdio" && !s.command?.trim()) return "Give the command that starts it.";
  if (s.transport === "http") {
    let u: URL;
    try {
      u = new URL(s.url ?? "");
    } catch {
      return "Give the server's address, starting https://.";
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
      return "A remote server's address must start https:// (http:// only for this computer).";
    }
  }
  const bad = s.envNames.find((n) => !ENV_NAME.test(n));
  if (bad !== undefined) return `“${bad}” isn't a variable name (letters, digits and _).`;
  return null;
}

export async function listMcpServers(db: SqlDb, tenant: Tenant): Promise<McpServer[]> {
  const rows = await db.select<Row>(
    `SELECT id, name, transport, command, args, url, env_names, network FROM mcp_servers
     WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE, created_at`,
    [tenant.workspaceId],
  );
  return rows.map(toServer);
}

export async function addMcpServer(db: SqlDb, tenant: Tenant, s: NewMcpServer): Promise<McpServer> {
  const problem = mcpServerProblem(s);
  if (problem) throw new Error(problem);
  const now = Date.now();
  const id = uuidv7(now);
  const server: McpServer = {
    ...s,
    id,
    name: s.name.trim(),
    command: s.transport === "stdio" ? (s.command?.trim() ?? null) : null,
    args: s.transport === "stdio" ? s.args : [],
    url: s.transport === "http" ? (s.url?.trim() ?? null) : null,
  };
  await db.execute(
    `INSERT INTO mcp_servers (id, workspace_id, user_id, name, transport, command, args, url,
       env_names, network, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenant.workspaceId,
      tenant.userId,
      server.name,
      server.transport,
      server.command,
      JSON.stringify(server.args),
      server.url,
      JSON.stringify(server.envNames),
      server.network ? 1 : 0,
      now,
      now,
    ],
  );
  return server;
}

export async function setMcpServerNetwork(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  network: boolean,
): Promise<void> {
  await db.execute(
    "UPDATE mcp_servers SET network = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    [network ? 1 : 0, Date.now(), tenant.workspaceId, id],
  );
}

/** Removes the server and its project links; its keychain values are removed by the caller. */
export async function removeMcpServer(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  const now = Date.now();
  await db.execute("DELETE FROM project_mcp_servers WHERE workspace_id = ? AND server_id = ?", [
    tenant.workspaceId,
    id,
  ]);
  await db.execute(
    "UPDATE mcp_servers SET deleted_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    [now, now, tenant.workspaceId, id],
  );
}

/** M9 step 9: the servers a project switched on for its chats and runs. */
export async function listProjectMcpServers(
  db: SqlDb,
  tenant: Tenant,
  projectId: string,
): Promise<McpServer[]> {
  const rows = await db.select<Row>(
    `SELECT s.id, s.name, s.transport, s.command, s.args, s.url, s.env_names, s.network
     FROM project_mcp_servers p JOIN mcp_servers s ON s.id = p.server_id
     WHERE p.workspace_id = ? AND p.project_id = ? AND s.deleted_at IS NULL
     ORDER BY s.name COLLATE NOCASE`,
    [tenant.workspaceId, projectId],
  );
  return rows.map(toServer);
}

export async function setProjectMcpServer(
  db: SqlDb,
  tenant: Tenant,
  projectId: string,
  serverId: string,
  on: boolean,
): Promise<void> {
  if (!on) {
    await db.execute(
      "DELETE FROM project_mcp_servers WHERE workspace_id = ? AND project_id = ? AND server_id = ?",
      [tenant.workspaceId, projectId, serverId],
    );
    return;
  }
  const now = Date.now();
  await db.execute(
    `INSERT OR IGNORE INTO project_mcp_servers (id, workspace_id, user_id, project_id, server_id,
       created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv7(now), tenant.workspaceId, tenant.userId, projectId, serverId, now],
  );
}
