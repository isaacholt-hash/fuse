// @vitest-environment node
import { strFromU8, unzipSync } from "fflate";
import { memoryFilesApi } from "@/files/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { addFile, linkFiles } from "@/storage/files";
import { addDecision, addMemory } from "@/storage/memories";
import { createProject } from "@/storage/projects";
import { addMessage } from "@/storage/messages";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread, setThreadProject } from "@/storage/threads";
import { EXPORTED_TABLES, exportAll, exportData, type ExportManifest } from "./exportAll";

const t = DEFAULT_TENANT;

test("every table as JSON, a Markdown file per chat, and the attachment files; no incognito", async () => {
  const db = openTestDb();
  const files = memoryFilesApi();
  const chat = await createThread(db, t, "Lisbon / trip");
  const q = await addMessage(db, t, {
    threadId: chat.id,
    parentId: null,
    role: "user",
    content: "Where to eat?",
  });
  await addMessage(db, t, {
    threadId: chat.id,
    parentId: q,
    role: "assistant",
    content: "Try Cervejaria Ramiro.",
    model: "claude-sonnet-5-5",
  });
  const stored = await files.put(new TextEncoder().encode("menu"));
  const file = await addFile(db, t, {
    name: "menu.txt",
    mime: "text/plain",
    sizeBytes: 4,
    sha256: stored.sha256,
  });
  await linkFiles(db, t, q, [file.id]);
  await addMemory(db, t, { text: "Likes seafood.", kind: "preference", confidence: 100 });
  const secret = await createThread(db, t, "Secret", null, true);
  await addMessage(db, t, { threadId: secret.id, parentId: null, role: "user", content: "hush" });

  const out = await exportAll(db, t, files, Date.UTC(2026, 9, 28));
  expect(out).toMatchObject({ chats: 1, files: 1 });
  const zip = unzipSync(out.bytes);
  const manifest = JSON.parse(
    strFromU8(zip["manifest.json"] ?? new Uint8Array()),
  ) as ExportManifest;
  expect(manifest).toMatchObject({
    format: "fuse-export",
    version: 2,
    exportedAt: "2026-10-28T00:00:00.000Z",
    scope: { kind: "all" },
    files: [{ sha256: stored.sha256, bytes: 4 }],
  });
  expect(Object.keys(manifest.tables)).toEqual([...EXPORTED_TABLES]);
  const records = (table: string) =>
    JSON.parse(strFromU8(zip[`records/${table}.json`] ?? new Uint8Array())) as Record<
      string,
      unknown
    >[];
  for (const table of EXPORTED_TABLES) {
    expect(records(table)).toHaveLength(manifest.tables[table] ?? -1);
  }
  expect(records("memories").map((m) => m.text)).toEqual(["Likes seafood."]);
  expect(records("threads").map((x) => x.title)).toEqual(["Lisbon / trip"]);
  expect(records("messages").map((x) => x.content)).not.toContain("hush");
  const md = Object.keys(zip).filter((k) => k.startsWith("chats/"));
  expect(md).toHaveLength(1);
  expect(md[0]).toMatch(/^chats\/\d{4}-\d{2}-\d{2} Lisbon - trip\.md$/);
  const text = strFromU8(zip[md[0] ?? ""] ?? new Uint8Array());
  expect(text).toContain("## You\n\nWhere to eat?");
  expect(text).toContain("## claude-sonnet-5-5\n\nTry Cervejaria Ramiro.");
  expect(strFromU8(zip[`files/${stored.sha256}`] ?? new Uint8Array())).toBe("menu");
});

test("one project: its chats, messages, files, memories and decisions, and nothing else (PL-12)", async () => {
  const db = openTestDb();
  const files = memoryFilesApi();
  const kitchen = await createProject(db, t, "Kitchen");
  const garden = await createProject(db, t, "Garden");
  const inKitchen = await createThread(db, t, "Worktops");
  await setThreadProject(db, t, inKitchen.id, kitchen.id);
  const inGarden = await createThread(db, t, "Beds");
  await setThreadProject(db, t, inGarden.id, garden.id);
  const q = await addMessage(db, t, {
    threadId: inKitchen.id,
    parentId: null,
    role: "user",
    content: "Oak or laminate?",
  });
  await addMessage(db, t, {
    threadId: inGarden.id,
    parentId: null,
    role: "user",
    content: "Soil?",
  });
  const plan = await files.put(new TextEncoder().encode("plan"));
  const file = await addFile(db, t, {
    name: "plan.txt",
    mime: "text/plain",
    sizeBytes: 4,
    sha256: plan.sha256,
  });
  await linkFiles(db, t, q, [file.id]);
  const other = await files.put(new TextEncoder().encode("seeds"));
  await addFile(db, t, {
    name: "seeds.txt",
    mime: "text/plain",
    sizeBytes: 5,
    sha256: other.sha256,
  });
  await addDecision(db, t, kitchen.id, { text: "Oak.", rationale: "", alternatives: [] });
  await addMemory(db, t, { text: "Raised beds.", kind: "fact", projectId: garden.id });
  await addMemory(db, t, { text: "Lives in Leeds.", kind: "fact" });

  const out = await exportData(db, t, files, { kind: "project", projectId: kitchen.id });
  expect(out).toMatchObject({ chats: 1, files: 1 });
  const zip = unzipSync(out.bytes);
  const manifest = JSON.parse(
    strFromU8(zip["manifest.json"] ?? new Uint8Array()),
  ) as ExportManifest;
  expect(manifest.scope).toEqual({ kind: "project", projectId: kitchen.id, name: "Kitchen" });
  const records = (table: string) =>
    JSON.parse(strFromU8(zip[`records/${table}.json`] ?? new Uint8Array())) as Record<
      string,
      unknown
    >[];
  expect(records("projects").map((p) => p.name)).toEqual(["Kitchen"]);
  expect(records("threads").map((x) => x.title)).toEqual(["Worktops"]);
  expect(records("messages").map((x) => x.content)).toEqual(["Oak or laminate?"]);
  expect(records("memories").map((m) => m.text)).toEqual(["Oak."]);
  expect(records("files").map((f) => f.name)).toEqual(["plan.txt"]);
  expect(Object.keys(zip).filter((k) => k.startsWith("files/"))).toEqual([`files/${plan.sha256}`]);
  await expect(exportData(db, t, files, { kind: "project", projectId: "missing" })).rejects.toThrow(
    /doesn't exist/,
  );
});
