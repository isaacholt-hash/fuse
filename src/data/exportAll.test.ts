// @vitest-environment node
import { strFromU8, unzipSync } from "fflate";
import { memoryFilesApi } from "@/files/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { addFile, linkFiles } from "@/storage/files";
import { addMemory } from "@/storage/memories";
import { addMessage } from "@/storage/messages";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread } from "@/storage/threads";
import { EXPORTED_TABLES, exportAll } from "./exportAll";

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
  await addMemory(db, t, { text: "Likes seafood.", category: "preference", confidence: 100 });
  const secret = await createThread(db, t, "Secret", null, true);
  await addMessage(db, t, { threadId: secret.id, parentId: null, role: "user", content: "hush" });

  const out = await exportAll(db, t, files, Date.UTC(2026, 9, 28));
  expect(out).toMatchObject({ chats: 1, files: 1 });
  const zip = unzipSync(out.bytes);
  const json = JSON.parse(strFromU8(zip["fuse-export.json"] ?? new Uint8Array())) as {
    tables: Record<string, Record<string, unknown>[]>;
  };
  expect(Object.keys(json.tables)).toEqual([...EXPORTED_TABLES]);
  expect(json.tables.memories?.map((m) => m.text)).toEqual(["Likes seafood."]);
  expect(json.tables.threads?.map((x) => x.title)).toEqual(["Lisbon / trip"]);
  expect(json.tables.messages?.map((x) => x.content)).not.toContain("hush");
  const md = Object.keys(zip).filter((k) => k.startsWith("chats/"));
  expect(md).toHaveLength(1);
  expect(md[0]).toMatch(/^chats\/\d{4}-\d{2}-\d{2} Lisbon - trip\.md$/);
  const text = strFromU8(zip[md[0] ?? ""] ?? new Uint8Array());
  expect(text).toContain("## You\n\nWhere to eat?");
  expect(text).toContain("## claude-sonnet-5-5\n\nTry Cervejaria Ramiro.");
  expect(strFromU8(zip[`files/${stored.sha256}`] ?? new Uint8Array())).toBe("menu");
});
