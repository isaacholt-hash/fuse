// @vitest-environment node
import { DEFAULT_TENANT } from "./defaults";
import { addMessage } from "./messages";
import { searchChats } from "./search";
import { openTestDb } from "./testing/nodeDb";
import {
  createThread,
  getThread,
  normaliseTag,
  purgeThread,
  setThreadArchived,
  setThreadPinned,
  setThreadTags,
} from "./threads";

const t = DEFAULT_TENANT;

test("tags are lowercase words without # or spaces", () => {
  expect(normaliseTag(" #Home Garden! ")).toBe("home-garden");
  expect(normaliseTag("###")).toBe("");
});

test("pin, archive and tags are saved on the chat; tags are cleaned and deduplicated", async () => {
  const db = openTestDb();
  const a = await createThread(db, t, "Tomatoes");
  await setThreadPinned(db, t, a.id, true);
  await setThreadArchived(db, t, a.id, true);
  expect(await setThreadTags(db, t, a.id, ["Garden", "#garden", "food", " "])).toEqual([
    "food",
    "garden",
  ]);
  let got = await getThread(db, t, a.id);
  expect(got?.pinnedAt).not.toBeNull();
  expect(got?.archivedAt).not.toBeNull();
  expect(got?.tags).toEqual(["food", "garden"]);
  await setThreadPinned(db, t, a.id, false);
  await setThreadArchived(db, t, a.id, false);
  await setThreadTags(db, t, a.id, ["food"]);
  got = await getThread(db, t, a.id);
  expect([got?.pinnedAt, got?.archivedAt, got?.tags]).toEqual([null, null, ["food"]]);
  await purgeThread(db, t, a.id);
  expect(await db.select(`SELECT * FROM thread_tags`)).toEqual([]);
});

test("#tag in a search narrows it to chats with that tag", async () => {
  const db = openTestDb();
  const a = await createThread(db, t, "Garden plans");
  const b = await createThread(db, t, "Work plans");
  for (const thread of [a, b]) {
    await addMessage(db, t, {
      threadId: thread.id,
      parentId: null,
      role: "user",
      content: "What should the plan include?",
    });
  }
  await setThreadTags(db, t, a.id, ["garden"]);
  const hits = await searchChats(db, t, "plan #garden");
  expect(new Set(hits.map((h) => h.threadId))).toEqual(new Set([a.id]));
  const onlyTag = await searchChats(db, t, "#Garden");
  expect(onlyTag.map((h) => [h.threadId, h.messageId])).toEqual([[a.id, null]]);
});

test("M10 step 12: a thread is made with its kind; sessions are named as sessions", async () => {
  const db = openTestDb();
  const chat = await createThread(db, t);
  expect(chat).toMatchObject({ kind: "chat", title: "New chat" });
  const work = await createThread(db, t, undefined, null, false, "work");
  expect(work).toMatchObject({ kind: "work", title: "New session" });
  expect((await getThread(db, t, work.id))?.kind).toBe("work");
});

test("M10 step 13: opened, marked unread, and the one-time settle of old threads", async () => {
  const { markThreadSeen, markThreadUnread, settleSeen } = await import("./threads");
  const db = openTestDb();
  const old = await createThread(db, t, "Old");
  expect(old.seenAt).toBeNull();
  await settleSeen(db, t, 500);
  expect((await getThread(db, t, old.id))?.seenAt).toBe(500);
  // Once per database: a thread made later stays never-opened.
  const later = await createThread(db, t, "Later");
  await settleSeen(db, t, 900);
  expect((await getThread(db, t, later.id))?.seenAt).toBeNull();
  await markThreadUnread(db, t, old.id);
  expect((await getThread(db, t, old.id))?.seenAt).toBe(0);
  await markThreadSeen(db, t, old.id, 1000);
  expect((await getThread(db, t, old.id))?.seenAt).toBe(1000);
});
