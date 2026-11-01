// @vitest-environment node
import { strToU8, unzipSync, zipSync, strFromU8 } from "fflate";
import { memoryFilesApi } from "@/files/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { addFile, linkFiles } from "@/storage/files";
import { addDecision, addMemory, addTask, listMemories } from "@/storage/memories";
import { addMessage, listMessages } from "@/storage/messages";
import { createProject } from "@/storage/projects";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread, listThreads, setThreadProject } from "@/storage/threads";
import { deleteAllData } from "./deleteAll";
import { EXPORTED_TABLES, exportAll } from "./exportAll";
import { applyRestore, onlyProject, planRestore, readFuseExport, RestoreError } from "./restore";

const t = DEFAULT_TENANT;

/** A workspace with two projects, chats, a file, typed memories and a global fact. */
async function sample() {
  const db = openTestDb();
  const files = memoryFilesApi();
  const kitchen = await createProject(db, t, "Kitchen");
  const garden = await createProject(db, t, "Garden");
  const chat = await createThread(db, t, "Worktops");
  await setThreadProject(db, t, chat.id, kitchen.id);
  const q = await addMessage(db, t, {
    threadId: chat.id,
    parentId: null,
    role: "user",
    content: "Oak?",
  });
  await addMessage(db, t, { threadId: chat.id, parentId: q, role: "assistant", content: "Yes." });
  const beds = await createThread(db, t, "Beds");
  await setThreadProject(db, t, beds.id, garden.id);
  await addMessage(db, t, { threadId: beds.id, parentId: null, role: "user", content: "Soil?" });
  const bytes = strToU8("plan");
  const stored = await files.put(bytes);
  const file = await addFile(db, t, {
    name: "plan.txt",
    mime: "text/plain",
    sizeBytes: 4,
    sha256: stored.sha256,
  });
  await linkFiles(db, t, q, [file.id]);
  await addDecision(db, t, kitchen.id, {
    text: "Oak.",
    rationale: "Lasts.",
    alternatives: ["Laminate"],
  });
  await addTask(db, t, kitchen.id, "Order samples");
  await addMemory(db, t, { text: "Lives in Leeds.", kind: "fact" });
  return { db, files, kitchen, garden, chat };
}

const recordsOf = (bytes: Uint8Array) => {
  const zip = unzipSync(bytes);
  return Object.fromEntries(
    EXPORTED_TABLES.map((table) => [
      table,
      JSON.parse(strFromU8(zip[`records/${table}.json`] ?? strToU8("[]"))) as unknown[],
    ]),
  );
};

test("export, wipe, restore: every record and file comes back as it was (PL-12)", async () => {
  const { db, files } = await sample();
  const before = await exportAll(db, t, files, 1);
  await deleteAllData(db, t, files);
  expect(await listThreads(db, t)).toEqual([]);

  const parsed = await readFuseExport(before.bytes);
  expect(parsed.version).toBe(2);
  expect((await planRestore(db, parsed)).every((c) => c.existing === 0)).toBe(true);
  const result = await applyRestore(db, t, parsed, files);
  expect(result.skipped).toBe(0);
  expect(result.files).toBe(1);
  const after = await exportAll(db, t, files, 1);
  expect(recordsOf(after.bytes)).toEqual(recordsOf(before.bytes));

  // Restoring again changes nothing: everything is already here.
  const again = await applyRestore(db, t, parsed, files);
  expect(again.added).toBe(0);
  expect((await planRestore(db, parsed)).every((c) => c.existing === c.rows)).toBe(true);
});

test("one project from a full export, into a workspace that never had it", async () => {
  const { db, files, kitchen } = await sample();
  const parsed = await readFuseExport((await exportAll(db, t, files)).bytes);
  expect(parsed.projects.map((p) => p.name).sort()).toEqual(["Garden", "Kitchen"]);

  const fresh = openTestDb();
  const freshFiles = memoryFilesApi();
  const one = onlyProject(parsed, kitchen.id);
  await applyRestore(fresh, t, one, freshFiles);
  const threads = await listThreads(fresh, t);
  expect(threads.map((x) => x.title)).toEqual(["Worktops"]);
  expect((await listMessages(fresh, t, threads[0]?.id ?? "")).map((m) => m.content)).toEqual([
    "Oak?",
    "Yes.",
  ]);
  expect((await listMemories(fresh, t)).map((m) => [m.kind, m.text])).toEqual([
    ["decision", "Oak."],
    ["task", "Order samples"],
  ]);
  expect((await listMemories(fresh, t))[0]?.alternatives).toEqual(["Laminate"]);
  expect(freshFiles.files.size).toBe(1);
});

test("exports are checked before anything is written", async () => {
  const { db, files } = await sample();
  const zip = unzipSync((await exportAll(db, t, files)).bytes);
  const remade = (change: (z: Record<string, Uint8Array>) => void) => {
    const copy = { ...zip };
    change(copy);
    return zipSync(copy);
  };
  await expect(readFuseExport(strToU8("not a zip"))).rejects.toThrow(RestoreError);
  await expect(readFuseExport(zipSync({ "hello.txt": strToU8("hi") }))).rejects.toThrow(
    /no manifest/,
  );
  const sha = Object.keys(zip).find((k) => k.startsWith("files/")) ?? "";
  await expect(
    readFuseExport(
      remade((z) => {
        z[sha] = strToU8("tampered");
      }),
    ),
  ).rejects.toThrow(/doesn't match its name/);
  await expect(
    readFuseExport(
      remade((z) => {
        z["records/memories.json"] = strToU8(JSON.stringify([{ id: "m", text: { evil: 1 } }]));
      }),
    ),
  ).rejects.toThrow(/isn't text or a number/);
  await expect(
    readFuseExport(
      remade((z) => {
        z["manifest.json"] = strToU8(JSON.stringify({ format: "fuse-export", version: 9 }));
      }),
    ),
  ).rejects.toThrow(/version 9/);
  // Unknown tables and stray files are ignored, not restored.
  const parsed = await readFuseExport(
    remade((z) => {
      z["records/settings.json"] = strToU8(JSON.stringify([{ id: "x", key: "k", value: "v" }]));
      z["../../evil"] = strToU8("x");
    }),
  );
  expect(Object.keys(parsed.records)).not.toContain("settings");
});

test("a version 1 export (one JSON file) still restores", async () => {
  const { db, files } = await sample();
  const v2 = await readFuseExport((await exportAll(db, t, files)).bytes);
  const v1 = zipSync({
    "fuse-export.json": strToU8(
      JSON.stringify({
        format: "fuse-export",
        version: 1,
        exportedAt: "2026-10-28",
        tables: v2.records,
      }),
    ),
  });
  const fresh = openTestDb();
  await applyRestore(fresh, t, await readFuseExport(v1), memoryFilesApi());
  expect((await listThreads(fresh, t)).map((x) => x.title).sort()).toEqual(["Beds", "Worktops"]);
});

test("M10 step 12: a session comes back as a session; an older export's threads come back as chats", async () => {
  const db = openTestDb();
  const files = memoryFilesApi();
  await createThread(db, t, "Notes");
  await createThread(db, t, "Fix the build", null, false, "code");
  const { bytes } = await exportAll(db, t, files, 1);
  const fresh = openTestDb();
  await applyRestore(fresh, t, await readFuseExport(bytes), memoryFilesApi());
  const kinds = async (d: typeof db) =>
    Object.fromEntries((await listThreads(d, t)).map((x) => [x.title, x.kind]));
  expect(await kinds(fresh)).toEqual({ Notes: "chat", "Fix the build": "code" });
  // Written before 0053: no kind column, so each thread is a chat (runs aren't exported).
  const entries = unzipSync(bytes);
  const rows = JSON.parse(strFromU8(entries["records/threads.json"] as Uint8Array)) as Record<
    string,
    unknown
  >[];
  entries["records/threads.json"] = strToU8(
    JSON.stringify(rows.map(({ kind: _kind, ...rest }) => rest)),
  );
  const older = openTestDb();
  await applyRestore(older, t, await readFuseExport(zipSync(entries)), memoryFilesApi());
  expect(await kinds(older)).toEqual({ Notes: "chat", "Fix the build": "chat" });
});
