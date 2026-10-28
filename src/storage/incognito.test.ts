// @vitest-environment node
import { addCitations } from "./citations";
import { DEFAULT_TENANT } from "./defaults";
import { addFile, linkFiles } from "./files";
import { addMessage } from "./messages";
import { listRecentRequests, logRequest } from "./requestLog";
import { searchChats } from "./search";
import { openTestDb } from "./testing/nodeDb";
import {
  createThread,
  getThread,
  listThreads,
  purgeIncognito,
  purgeThread,
  setActiveLeaf,
} from "./threads";
import { EMPTY_USAGE } from "./usage";

const t = DEFAULT_TENANT;

async function chat(db: ReturnType<typeof openTestDb>, incognito: boolean) {
  const thread = await createThread(db, t, "Secret plans", null, incognito);
  const q = await addMessage(db, t, {
    threadId: thread.id,
    parentId: null,
    role: "user",
    content: "surprise party",
  });
  const a = await addMessage(db, t, {
    threadId: thread.id,
    parentId: q,
    role: "assistant",
    content: "ok",
  });
  const a2 = await addMessage(db, t, {
    threadId: thread.id,
    parentId: q,
    role: "assistant",
    content: "better",
    escalatedFromId: a,
  });
  await setActiveLeaf(db, t, thread.id, a2);
  const file = await addFile(db, t, {
    name: "x.txt",
    mime: "text/plain",
    sizeBytes: 1,
    sha256: "ab",
    threadId: thread.id,
  });
  await linkFiles(db, t, q, [file.id]);
  await addCitations(db, t, a, [{ url: "https://example.com", title: null }]);
  await logRequest(db, t, {
    threadId: thread.id,
    messageId: a,
    purpose: "chat",
    provider: "openai",
    model: "m",
    attempt: 1,
    usage: { ...EMPTY_USAGE, costMicroUsd: 1234 },
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
    providerRequestId: null,
  });
  return thread;
}

test("an incognito chat has memory off, is never searched, and purges completely", async () => {
  const db = openTestDb();
  const secret = await chat(db, true);
  const normal = await chat(db, false);
  expect((await getThread(db, t, secret.id))?.memoryOn).toBe(false);
  expect((await getThread(db, t, secret.id))?.incognito).toBe(true);
  expect((await searchChats(db, t, "surprise")).every((h) => h.threadId === normal.id)).toBe(true);

  await purgeThread(db, t, secret.id);
  expect(await getThread(db, t, secret.id)).toBeNull();
  const left = await db.select<{ n: number }>(
    "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?",
    [secret.id],
  );
  expect(left[0]?.n).toBe(0);
  // Costs stay in the request log, unlinked; the normal chat is untouched.
  const log = await listRecentRequests(db, t, 10);
  expect(log.map((r) => r.threadId).sort()).toEqual([normal.id, null].sort());
  expect(log.reduce((sum, r) => sum + r.usage.costMicroUsd, 0)).toBe(2468);
  expect((await listThreads(db, t)).map((x) => x.id)).toEqual([normal.id]);
});

test("purgeIncognito clears any incognito chat left by a crash", async () => {
  const db = openTestDb();
  await chat(db, true);
  const normal = await chat(db, false);
  await purgeIncognito(db, t);
  expect((await listThreads(db, t)).map((x) => x.id)).toEqual([normal.id]);
});
