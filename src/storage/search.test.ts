// @vitest-environment node
import { DEFAULT_TENANT } from "./defaults";
import { addMessage, deleteMessage, updateMessageContent } from "./messages";
import { ftsQuery, MARK_END, MARK_START, searchChats } from "./search";
import { openTestDb } from "./testing/nodeDb";
import { createThread, deleteThread, renameThread } from "./threads";

const t = DEFAULT_TENANT;

test("search words become quoted prefix terms; FTS syntax can't leak in", () => {
  expect(ftsQuery("air fryer")).toBe('"air"* "fryer"*');
  expect(ftsQuery('NEAR(") OR *')).toBe('"NEAR"* "OR"*');
  expect(ftsQuery("  ?! ")).toBeNull();
  expect(ftsQuery("café")).toBe('"café"*');
});

test("finds messages and titles, follows edits, skips deleted messages and chats", async () => {
  const db = openTestDb();
  const a = await createThread(db, t, "Kitchen gadgets");
  const b = await createThread(db, t, "Car");
  const q = await addMessage(db, t, {
    threadId: a.id,
    parentId: null,
    role: "user",
    content: "How do I cook sausages in an air fryer?",
  });
  const ans = await addMessage(db, t, {
    threadId: a.id,
    parentId: q,
    role: "assistant",
    content: "",
    status: "streaming",
  });
  await updateMessageContent(db, t, ans, "Cook them at 180°C for twelve minutes, turning once.");
  await addMessage(db, t, {
    threadId: b.id,
    parentId: null,
    role: "user",
    content: "Oil change interval?",
  });

  let hits = await searchChats(db, t, "air fry");
  expect(hits.map((h) => [h.threadTitle, h.messageId, h.role])).toEqual([
    ["Kitchen gadgets", q, "user"],
  ]);
  expect(hits[0]?.snippet).toContain(`${MARK_START}air${MARK_END}`);

  // Text saved while streaming is searchable.
  hits = await searchChats(db, t, "twelve minutes");
  expect(hits.map((h) => h.messageId)).toEqual([ans]);

  // Titles match too (accents and case don't matter in messages; titles use LIKE).
  await renameThread(db, t, b.id, "Atlas maintenance");
  hits = await searchChats(db, t, "atlas");
  expect(hits.map((h) => [h.threadId, h.messageId])).toEqual([[b.id, null]]);

  await deleteMessage(db, t, q);
  expect(await searchChats(db, t, "air fryer")).toEqual([]);
  await deleteThread(db, t, a.id);
  expect(await searchChats(db, t, "twelve")).toEqual([]);
});
