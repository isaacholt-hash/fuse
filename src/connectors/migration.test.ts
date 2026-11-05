// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { migrationFiles, openTestDb } from "@/storage/testing/nodeDb";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { DELETE_ORDER, deleteAllData } from "@/data/deleteAll";
import { EXPORTED_TABLES } from "@/data/exportAll";
import { listConnectorRegistrations } from "./storage";
import { memoryFilesApi } from "@/files/api";
import { addMcpServer, listProjectMcpServers, setProjectMcpServer } from "@/storage/mcp";
import { createProject } from "@/storage/projects";
import registry from "../../data/sync.json";

test("schema 67 preserves existing servers, history, permissions and sync events", () => {
  const db = new DatabaseSync(":memory:");
  const sql = (f: string) =>
    readFileSync(new URL(`../../src-tauri/migrations/${f}`, import.meta.url), "utf8");
  for (const f of migrationFiles().filter((f) => f < "0067")) db.exec(sql(f));
  db.exec("UPDATE sync_state SET enabled=1");
  db.prepare(
    "INSERT INTO mcp_servers(id,workspace_id,user_id,name,transport,command,created_at,updated_at) VALUES('old',?,?,'Existing server','stdio','fixture',1,2)",
  ).run(tenant.workspaceId, tenant.userId);
  const old = db
    .prepare("SELECT id,name,transport,command,created_at,updated_at FROM mcp_servers")
    .all();
  const events = db.prepare("SELECT * FROM sync_outbox").all();
  db.exec("BEGIN IMMEDIATE");
  db.exec(sql("0067_connector_accounts.sql"));
  db.exec("COMMIT");
  expect(
    db.prepare("SELECT id,name,transport,command,created_at,updated_at FROM mcp_servers").all(),
  ).toEqual(old);
  expect(db.prepare("SELECT builtin_kind FROM mcp_servers").all()).toEqual([
    { builtin_kind: null },
  ]);
  expect(db.prepare("SELECT * FROM sync_outbox").all()).toEqual(events);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(registry.localTables).toHaveProperty("connector_accounts");
  expect(EXPORTED_TABLES).not.toContain("connector_accounts");
  expect(DELETE_ORDER.indexOf("connector_accounts")).toBeLessThan(
    DELETE_ORDER.indexOf("mcp_servers"),
  );
  db.close();
});
test("built-in MCP accounts require ordinary explicit project links and are cleared by global deletion", async () => {
  const db = openTestDb();
  const server = await addMcpServer(db, tenant, {
    name: "Microsoft",
    transport: "http",
    url: "https://graph.microsoft.com",
    command: null,
    args: [],
    envNames: [],
    network: false,
  });
  await db.execute("UPDATE mcp_servers SET builtin_kind='microsoft',url=NULL WHERE id=?", [
    server.id,
  ]);
  await db.execute(
    "INSERT INTO connector_accounts(id,workspace_id,user_id,client_id,tenant,services,created_at,updated_at) VALUES(?,?,?,'public-application','common','[\"mail\"]',1,2)",
    [server.id, tenant.workspaceId, tenant.userId],
  );
  const p = await createProject(db, tenant, "Reader project");
  expect(await listProjectMcpServers(db, tenant, p.id)).toEqual([]);
  await setProjectMcpServer(db, tenant, p.id, server.id, true);
  expect(await listProjectMcpServers(db, tenant, p.id)).toHaveLength(1);
  expect(await listConnectorRegistrations(db, tenant)).toEqual([
    {
      ...tenant,
      id: server.id,
      kind: "microsoft",
      clientId: "public-application",
      tenant: "common",
      services: ["mail"],
    },
  ]);
  expect(await listConnectorRegistrations(db, { ...tenant, userId: "other" })).toEqual([]);
  await db.execute('UPDATE connector_accounts SET services=\'["mail","calendar"]\' WHERE id=?', [
    server.id,
  ]);
  expect(
    await db.select("SELECT * FROM security_audit WHERE scope_id=?", [server.id]),
  ).toHaveLength(1);
  await deleteAllData(db, tenant, memoryFilesApi());
  expect(await listConnectorRegistrations(db, tenant)).toEqual([]);
  expect(await db.select("PRAGMA foreign_key_check")).toEqual([]);
});
