// @vitest-environment node
// M9 step 8: MCP servers as records.
import { deleteAllData } from "@/data/deleteAll";
import { memoryFilesApi } from "@/files/api";
import { DEFAULT_TENANT } from "./defaults";
import {
  addMcpServer,
  listMcpServers,
  mcpServerProblem,
  removeMcpServer,
  setMcpServerNetwork,
  listProjectMcpServers,
  setProjectMcpServer,
  type NewMcpServer,
} from "./mcp";
import { createProject } from "./projects";
import { openTestDb } from "./testing/nodeDb";

const t = DEFAULT_TENANT;
const local: NewMcpServer = {
  name: "Memory",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-memory"],
  url: null,
  envNames: ["API_TOKEN"],
  network: false,
};

test("what can't be added says why", () => {
  expect(mcpServerProblem({ ...local, name: " " })).toMatch(/name/);
  expect(mcpServerProblem({ ...local, command: "" })).toMatch(/command/);
  expect(mcpServerProblem({ ...local, envNames: ["bad-name"] })).toMatch(/isn't a variable name/);
  const http = { ...local, transport: "http" as const, command: null, args: [] };
  expect(mcpServerProblem({ ...http, url: "ftp://x" })).toMatch(/https/);
  expect(mcpServerProblem({ ...http, url: "http://example.com/mcp" })).toMatch(/https/);
  expect(mcpServerProblem({ ...http, url: "http://localhost:3000/mcp" })).toBeNull();
  expect(mcpServerProblem({ ...http, url: "https://example.com/mcp" })).toBeNull();
  expect(mcpServerProblem(local)).toBeNull();
});

test("added, listed by name, network switched, removed with its project links", async () => {
  const db = openTestDb();
  const a = await addMcpServer(db, t, { ...local, name: "  Zed  " });
  await addMcpServer(db, t, {
    ...local,
    name: "Alpha",
    transport: "http",
    command: "ignored",
    url: "https://example.com/mcp",
  });
  const listed = await listMcpServers(db, t);
  expect(listed.map((s) => s.name)).toEqual(["Alpha", "Zed"]);
  // A remote server keeps no command; a local one no URL.
  expect(listed[0]).toMatchObject({ command: null, args: [], url: "https://example.com/mcp" });
  expect(listed[1]).toMatchObject({ command: "npx", envNames: ["API_TOKEN"], network: false });
  await expect(addMcpServer(db, t, { ...local, name: "" })).rejects.toThrow(/name/);

  await setMcpServerNetwork(db, t, a.id, true);
  expect((await listMcpServers(db, t)).find((s) => s.id === a.id)?.network).toBe(true);

  const p = await createProject(db, t, "P");
  await db.execute(
    `INSERT INTO project_mcp_servers (id, workspace_id, user_id, project_id, server_id, created_at)
     VALUES ('l1', ?, ?, ?, ?, 0)`,
    [t.workspaceId, t.userId, p.id, a.id],
  );
  await removeMcpServer(db, t, a.id);
  expect((await listMcpServers(db, t)).map((s) => s.name)).toEqual(["Alpha"]);
  expect(await db.select("SELECT * FROM project_mcp_servers")).toEqual([]);

  await deleteAllData(db, t, memoryFilesApi());
  expect(await db.select("SELECT * FROM mcp_servers")).toEqual([]);
});

test("M9 step 9: a project switches servers on and off", async () => {
  const db = openTestDb();
  const a = await addMcpServer(db, t, { ...local, name: "B server" });
  const b = await addMcpServer(db, t, { ...local, name: "A server" });
  const p = await createProject(db, t, "P");
  await setProjectMcpServer(db, t, p.id, a.id, true);
  await setProjectMcpServer(db, t, p.id, b.id, true);
  await setProjectMcpServer(db, t, p.id, b.id, true);
  expect((await listProjectMcpServers(db, t, p.id)).map((s) => s.name)).toEqual([
    "A server",
    "B server",
  ]);
  await setProjectMcpServer(db, t, p.id, a.id, false);
  expect((await listProjectMcpServers(db, t, p.id)).map((s) => s.name)).toEqual(["A server"]);
  await removeMcpServer(db, t, b.id);
  expect(await listProjectMcpServers(db, t, p.id)).toEqual([]);
});
