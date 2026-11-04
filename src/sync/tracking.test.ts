// @vitest-environment node
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { createThread, deleteThread, purgeThread, restoreThread } from "@/storage/threads";
import { addMessage, finishMessage, updateMessageContent } from "@/storage/messages";
import { addMemory, editMemory } from "@/storage/memories";
import { createProject, deleteProject, setProjectPrivacy } from "@/storage/projects";
import { setSetting } from "@/storage/settings";
import { openTestDb } from "@/storage/testing/nodeDb";
import { EMPTY_USAGE } from "@/storage/usage";
import { addFile } from "@/storage/files";
import { addProjectFile } from "@/storage/projectFiles";
import { syncRegistry } from "./registry";

const enable = (db: ReturnType<typeof openTestDb>) => db.execute("UPDATE sync_state SET enabled=1");
const outbox = (db: ReturnType<typeof openTestDb>) =>
  db.select<{ table_name: string; operation: string; payload: string | null; version: string }>(
    "SELECT table_name,operation,payload,version FROM sync_outbox ORDER BY seq",
  );

test("every real table and portable column is explicitly classified", () => {
  const db = openTestDb();
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string;
  }[];
  for (const { name } of tables) {
    if (/^(sqlite_|_sqlx_)|^(messages|chunks)_fts/.test(name)) continue;
    const spec = syncRegistry.tables[name];
    expect(
      Boolean(spec || syncRegistry.localTables[name] || syncRegistry.internalTables.includes(name)),
      name,
    ).toBe(true);
    if (!spec) continue;
    const columns = db.raw.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
    expect([...spec.columns, ...spec.localColumns].sort(), name).toEqual(
      columns.map((c) => c.name).sort(),
    );
    const triggers = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE ?")
      .all(`sync_${name}_%`);
    expect(triggers, name).toHaveLength(3);
  }
});

test("installing and pairing alone capture nothing; one local change and its vector commit together", async () => {
  const db = openTestDb();
  await createThread(db, tenant, "Not enrolled");
  expect(await outbox(db)).toEqual([]);
  await enable(db);
  const thread = await createThread(db, tenant, "Shared");
  const events = await outbox(db);
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({ id: thread.id, title: "Shared" });
  expect(Object.values(JSON.parse(events[0]?.version ?? "{}") as Record<string, unknown>)).toEqual([
    1,
  ]);
  await db.execute("UPDATE threads SET seen_at=42 WHERE id=?", [thread.id]);
  expect(await outbox(db)).toHaveLength(1);
});

test("rollback restores data, outbox, metadata and sequence; incoming suppression cannot survive a failed transaction", async () => {
  const db = openTestDb();
  await enable(db);
  const thread = await createThread(db, tenant, "Before");
  const before = await db.select("SELECT * FROM sync_state");
  await expect(
    db.batch([
      { sql: "UPDATE threads SET title='After' WHERE id=?", params: [thread.id] },
      { sql: "UPDATE sync_state SET applying=1" },
      { sql: "INSERT INTO no_such_table VALUES (1)" },
    ]),
  ).rejects.toThrow();
  expect(await db.select("SELECT * FROM sync_state")).toEqual(before);
  expect(await db.select("SELECT title FROM threads WHERE id=?", [thread.id])).toEqual([
    { title: "Before" },
  ]);
  expect(await outbox(db)).toHaveLength(1);
  await db.batch([
    { sql: "UPDATE sync_state SET applying=1" },
    { sql: "UPDATE threads SET title='Remote' WHERE id=?", params: [thread.id] },
    { sql: "UPDATE sync_state SET applying=0" },
  ]);
  expect(await outbox(db)).toHaveLength(1);
  await db.execute("UPDATE threads SET title='Local' WHERE id=?", [thread.id]);
  expect(await outbox(db)).toHaveLength(2);
});

test("private scopes and machine settings are absent, and withdrawal carries no content", async () => {
  const db = openTestDb();
  const project = await createProject(db, tenant, "Private project");
  await setProjectPrivacy(db, tenant, project.id, { mode: "local_only", allowEmbeddings: false });
  await enable(db);
  await createThread(db, tenant, "Incognito", null, true);
  await createThread(db, tenant, "Private", project.id);
  await setSetting(db, tenant, "lock.hash", "not-a-real-lock");
  expect(await outbox(db)).toEqual([]);
  await setSetting(db, tenant, "memory.suggest", "off");
  expect(await outbox(db)).toHaveLength(1);
  const shared = await createProject(db, tenant, "Shared project");
  await setProjectPrivacy(db, tenant, shared.id, { mode: "local_only", allowEmbeddings: false });
  const last = (await outbox(db)).at(-1);
  expect(last).toMatchObject({ table_name: "projects", operation: "withdraw", payload: null });
});

test("streaming does not create sync writes; final answers do", async () => {
  const db = openTestDb();
  await enable(db);
  const thread = await createThread(db, tenant, "Chat");
  const id = await addMessage(db, tenant, {
    threadId: thread.id,
    parentId: null,
    role: "assistant",
    content: "",
    status: "streaming",
  });
  for (let i = 0; i < 100; i++) await updateMessageContent(db, tenant, id, String(i));
  expect((await outbox(db)).filter((e) => e.table_name === "messages")).toEqual([]);
  await finishMessage(db, tenant, id, { content: "Done", status: "complete", usage: EMPTY_USAGE });
  expect((await outbox(db)).filter((e) => e.table_name === "messages")).toHaveLength(1);
});

test("orphan/indexed-folder files cannot leak before a private knowledge link is written", async () => {
  const db = openTestDb();
  const project = await createProject(db, tenant, "Private");
  await setProjectPrivacy(db, tenant, project.id, { mode: "local_only", allowEmbeddings: false });
  await enable(db);
  const file = await addFile(db, tenant, {
    name: "private-notes.txt",
    mime: "text/plain",
    sizeBytes: 10,
    sha256: "a".repeat(64),
  });
  expect(await outbox(db)).toEqual([]);
  await addProjectFile(db, tenant, project.id, file.id);
  expect(await outbox(db)).toEqual([]);
});

test("undo window does not publish a deletion; final purge publishes content-free tombstones", async () => {
  const db = openTestDb();
  await enable(db);
  const thread = await createThread(db, tenant, "Chat");
  await deleteThread(db, tenant, thread.id);
  expect(await outbox(db)).toHaveLength(1);
  await restoreThread(db, tenant, thread.id);
  await deleteThread(db, tenant, thread.id);
  await purgeThread(db, tenant, thread.id);
  expect((await outbox(db)).at(-1)).toMatchObject({
    table_name: "threads",
    operation: "delete",
    payload: null,
  });
});

test("memory metadata agrees with captured revisions without recursive trigger loops", async () => {
  const db = openTestDb();
  db.raw.exec("PRAGMA recursive_triggers=ON");
  await enable(db);
  const id = await addMemory(db, tenant, { text: "First", kind: "fact" });
  await editMemory(db, tenant, id, { text: "Second", kind: "fact", projectId: null });
  const records = await db.select<{ revision: number; device_id: string }>(
    "SELECT revision,device_id FROM memories WHERE id=?",
    [id],
  );
  const payload = JSON.parse((await outbox(db)).at(-1)?.payload ?? "{}") as Record<string, unknown>;
  expect(payload).toMatchObject(records[0] ?? {});
  expect(await outbox(db)).toHaveLength(2);
});

test("portable types and foreign-key publication rules match the real schema", () => {
  const db = openTestDb();
  for (const [table, spec] of Object.entries(syncRegistry.tables)) {
    const columns = db.raw.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
      type: string;
      notnull: number;
    }[];
    expect(Object.keys(spec.types).sort(), table).toEqual([...spec.columns].sort());
    for (const column of columns.filter((c) => spec.columns.includes(c.name)))
      expect(spec.types[column.name], `${table}.${column.name}`).toBe(column.type.toUpperCase());
    const refs = db.raw.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
      from: string;
      table: string;
      to: string;
    }[];
    expect(
      spec.references.map((ref) => ({
        column: ref.column,
        table: ref.table,
        target: ref.target,
        optional: ref.optional,
      })),
      table,
    ).toEqual(
      refs
        .filter((r) => spec.columns.includes(r.from) && Boolean(syncRegistry.tables[r.table]))
        .map((r) => ({
          column: r.from,
          table: r.table,
          target: r.to,
          optional: columns.find((c) => c.name === r.from)?.notnull === 0,
        }))
        .sort((a, b) => a.column.localeCompare(b.column)),
    );
  }
});

test("disable retains changes after enrollment while a never-enrolled install captures nothing", async () => {
  const db = openTestDb();
  await createThread(db, tenant, "Before any enrollment");
  expect(await outbox(db)).toEqual([]);
  await db.execute("UPDATE sync_state SET epoch=1,enabled=0");
  const thread = await createThread(db, tenant, "Queued while transfers are disabled");
  expect(await outbox(db)).toHaveLength(1);
  const identity = await db.select<{ original_id: string }>(
    "SELECT original_id FROM sync_entities WHERE table_name='threads'",
  );
  expect(identity).toEqual([{ original_id: thread.id }]);
});

test("deleting a local-only project preserves its former chats' and prompts' privacy atomically", async () => {
  const db = openTestDb();
  const p = await createProject(db, tenant, "Private");
  await setProjectPrivacy(db, tenant, p.id, { mode: "local_only", allowEmbeddings: false });
  const t = await createThread(db, tenant, "Private history", p.id);
  await db.execute(
    "INSERT INTO prompts(id,workspace_id,user_id,name,body,project_id,created_at,updated_at) VALUES ('private-prompt',?,?, 'Private','Private template',?,1,1)",
    [tenant.workspaceId, tenant.userId, p.id],
  );
  await enable(db);
  await deleteProject(db, tenant, p.id);
  expect(await db.select("SELECT project_id,local_only FROM threads WHERE id=?", [t.id])).toEqual([
    { project_id: null, local_only: 1 },
  ]);
  expect(
    await db.select("SELECT project_id,sync_local_only FROM prompts WHERE id='private-prompt'"),
  ).toEqual([{ project_id: null, sync_local_only: 1 }]);
  expect(
    (await outbox(db)).filter((e) => e.table_name === "threads" || e.table_name === "prompts"),
  ).toEqual([]);
});

test("SQLite's compact reference rules exactly match the central portable registry", async () => {
  const db = openTestDb();
  const actual = await db.select(
    "SELECT table_name,column_name,parent_table,target,parent_has_id FROM sync_reference_rules ORDER BY table_name,column_name",
  );
  const expected = Object.entries(syncRegistry.tables)
    .flatMap(([table, spec]) =>
      spec.references.map((r) => ({
        table_name: table,
        column_name: r.column,
        parent_table: r.table,
        target: r.target,
        parent_has_id: Number(JSON.stringify(syncRegistry.tables[r.table]?.key) === '["id"]'),
      })),
    )
    .sort(
      (a, b) =>
        a.table_name.localeCompare(b.table_name) || a.column_name.localeCompare(b.column_name),
    );
  expect(actual).toEqual(expected);
});
