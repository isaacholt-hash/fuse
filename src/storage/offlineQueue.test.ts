// @vitest-environment node
import { DEFAULT_TENANT as t } from "./defaults";
import { cancelQueued, editQueued, listQueue, queueMessage, queuedCounts } from "./offlineQueue";
import { openTestDb } from "./testing/nodeDb";
import { createThread, purgeThread } from "./threads";

const origin = "install-a";

test("a saved chat queues with a fixed identity; edit and cancel only while waiting", async () => {
  const db = openTestDb();
  const thread = await createThread(db, t);
  const first = await queueMessage(db, t, {
    threadId: thread.id,
    text: "  Summarize the plan  ",
    effort: null,
    origin,
  });
  expect(first).toMatchObject({ text: "Summarize the plan", state: "queued" });
  const second = await queueMessage(db, t, {
    threadId: thread.id,
    text: "Then list risks",
    effort: "high",
    origin,
  });
  await editQueued(db, t, first.id, "Summarize the plan in 3 bullets");
  const queue = await listQueue(db, t, thread.id);
  expect(queue.map((q) => [q.id, q.text, q.effort])).toEqual([
    [first.id, "Summarize the plan in 3 bullets", null],
    [second.id, "Then list risks", "high"],
  ]);
  expect(await queuedCounts(db, t)).toEqual(new Map([[thread.id, 2]]));

  await cancelQueued(db, t, second.id);
  expect((await listQueue(db, t)).map((q) => q.id)).toEqual([first.id]);
  await expect(editQueued(db, t, second.id, "late")).rejects.toThrow("isn't waiting");

  // A claimed message is no longer editable or cancellable.
  await db.execute("UPDATE offline_queue SET state='dispatching' WHERE id=?", [first.id]);
  await expect(editQueued(db, t, first.id, "changed")).rejects.toThrow("isn't waiting");
  await cancelQueued(db, t, first.id);
  expect((await listQueue(db, t))[0]?.state).toBe("dispatching");
  await expect(
    queueMessage(db, t, { threadId: thread.id, text: "   ", effort: null, origin }),
  ).rejects.toThrow("can't be empty");
});

test("incognito, Code sessions and deleted chats can't queue; closing a chat blocks its queue", async () => {
  const db = openTestDb();
  const incognito = await createThread(db, t, undefined, null, true);
  await expect(
    queueMessage(db, t, { threadId: incognito.id, text: "secret", effort: null, origin }),
  ).rejects.toThrow();
  const session = await createThread(db, t, "Fix it", null, false, "code");
  await expect(
    queueMessage(db, t, { threadId: session.id, text: "run", effort: null, origin }),
  ).rejects.toThrow();

  const chat = await createThread(db, t);
  const waiting = await queueMessage(db, t, {
    threadId: chat.id,
    text: "hi",
    effort: null,
    origin,
  });
  await db.execute("UPDATE threads SET incognito=1 WHERE id=?", [chat.id]);
  expect((await listQueue(db, t))[0]).toMatchObject({ id: waiting.id, state: "blocked" });
  expect(await queuedCounts(db, t)).toEqual(new Map());

  const other = await createThread(db, t);
  await queueMessage(db, t, { threadId: other.id, text: "later", effort: null, origin });
  await db.execute("UPDATE threads SET deleted_at=1 WHERE id=?", [other.id]);
  expect((await listQueue(db, t, other.id))[0]?.state).toBe("blocked");
  await purgeThread(db, t, other.id);
  expect(await listQueue(db, t, other.id)).toEqual([]);
});
