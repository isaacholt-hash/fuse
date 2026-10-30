// @vitest-environment node
import { memoryFilesApi } from "@/files/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { addMemory } from "@/storage/memories";
import { addMessage } from "@/storage/messages";
import { createProject } from "@/storage/projects";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread, listThreads } from "@/storage/threads";
import { EXPORTED_TABLES } from "./exportAll";
import { DELETE_ORDER, deleteAllData } from "./deleteAll";

const t = DEFAULT_TENANT;

test("every data table ends up empty; the workspace stays", async () => {
  const db = openTestDb();
  const files = memoryFilesApi();
  const project = await createProject(db, t, "Work");
  const thread = await createThread(db, t, "x", project.id);
  const q = await addMessage(db, t, {
    threadId: thread.id,
    parentId: null,
    role: "user",
    content: "hi",
  });
  await addMessage(db, t, { threadId: thread.id, parentId: q, role: "assistant", content: "yo" });
  await addMemory(db, t, { text: "fact", kind: "fact", confidence: 100 });
  await files.put(new Uint8Array([1, 2]));

  const out = await deleteAllData(db, t, files);
  expect(out.files).toBe(1);
  expect(out.rows).toBeGreaterThanOrEqual(5);
  for (const table of [...EXPORTED_TABLES, "chunks", "chunk_vectors", "settings"]) {
    const [row] = await db.select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    expect(row?.n, table).toBe(0);
  }
  expect(await listThreads(db, t)).toEqual([]);
  const [ws] = await db.select<{ n: number }>("SELECT COUNT(*) AS n FROM workspaces");
  expect(ws?.n).toBe(1);
});

test("delete everything covers every table but the workspace, the user and the schema record", async () => {
  const db = openTestDb();
  const tables = (
    await db.select<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '%_fts%'`,
    )
  ).map((r) => r.name);
  const kept = ["workspaces", "users", "schema_meta"];
  expect(
    tables.filter((t) => !kept.includes(t) && !(DELETE_ORDER as readonly string[]).includes(t)),
  ).toEqual([]);
});
