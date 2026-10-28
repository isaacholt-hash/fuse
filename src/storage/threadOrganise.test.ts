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
