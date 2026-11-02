// @vitest-environment node
// M10 step 18: deleting for real. One chat with every kind of row that can hang off it, then
// the purge, the message-tree deletes and the startup sweep.
import { saveArtifacts } from "./artifacts";
import { spentSince } from "./budgets";
import { addCitations } from "./citations";
import { DEFAULT_TENANT } from "./defaults";
import { addFile, linkFiles } from "./files";
import { grantFolder, linkThreadFolder } from "./folders";
import { addMemory, addProposals, listMemoryRecords } from "./memories";
import {
  addMessage,
  deleteMessageTree,
  listPath,
  purgeMessages,
  restoreMessages,
} from "./messages";
import { allowNetwork } from "./network";
import { createProject } from "./projects";
import { sweepDeleted } from "./purge";
import { logRequest } from "./requestLog";
import { addApproval, askToStart, setLive } from "./runQueue";
import { addChange, addModelStep, createRun } from "./runs";
import { createSchedule } from "./schedules";
import { searchChats } from "./search";
import { addSummary } from "./summaries";
import { openTestDb } from "./testing/nodeDb";
import {
  createThread,
  deleteThread,
  getThread,
  listThreads,
  purgeThread,
  restoreThread,
  setActiveLeaf,
  setThreadHandoff,
} from "./threads";
import { branchesOf } from "./tree";
import { EMPTY_USAGE } from "./usage";
import { replaceChunks, saveVectors } from "./vectors";

const t = DEFAULT_TENANT;
type Db = ReturnType<typeof openTestDb>;

const count = async (db: Db, sql: string, params: (string | number)[] = []) =>
  (await db.select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${sql}`, params))[0]?.n ?? -1;
const fkCheck = (db: Db) => db.raw.prepare("PRAGMA foreign_key_check").all();

const say = (
  db: Db,
  threadId: string,
  parentId: string | null,
  role: "user" | "assistant",
  content: string,
  escalatedFromId?: string,
) =>
  addMessage(db, t, {
    threadId,
    parentId,
    role,
    content,
    ...(escalatedFromId ? { escalatedFromId } : {}),
  });

/**
 * A chat in a project: q1 → a1 (re-run as a1b) and a1x (a regenerate), q2 under a1b, a2 under
 * q2 (the leaf). Plus a file, a citation, a request-log row, a run with step, change, approval,
 * live text and a queued request, a schedule that last ran it, a network grant, a folder link,
 * a memory scoped to it (with a chunk and vector), a memory that cites it, a pending proposal,
 * a summary, an artifact, and another chat handed off from it.
 */
async function fullChat(db: Db) {
  const project = await createProject(db, t, "Kitchen");
  const thread = await createThread(db, t, "Tile budget", project.id);
  const q1 = await say(db, thread.id, null, "user", "Total the tile quotes");
  const a1 = await say(db, thread.id, q1, "assistant", "Marrakech includes trim");
  const a1b = await say(db, thread.id, q1, "assistant", "Marrakech includes the trim pieces", a1);
  const a1x = await say(db, thread.id, q1, "assistant", "Topps is cheapest");
  const q2 = await say(db, thread.id, a1b, "user", "Work out the cost per square metre");
  const a2 = await say(db, thread.id, q2, "assistant", "About £125 per metre");
  await setActiveLeaf(db, t, thread.id, a2);
  const file = await addFile(db, t, {
    name: "quote.pdf",
    mime: "application/pdf",
    sizeBytes: 3,
    sha256: "aa",
    threadId: thread.id,
  });
  await linkFiles(db, t, q1, [file.id]);
  await addCitations(db, t, a1, [{ url: "https://example.com/tiles", title: null }]);
  const requestId = await logRequest(db, t, {
    threadId: thread.id,
    messageId: a1,
    purpose: "chat",
    provider: "anthropic",
    model: "m",
    attempt: 1,
    usage: { ...EMPTY_USAGE, costMicroUsd: 1234 },
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
    providerRequestId: null,
  });
  const run = await createRun(db, t, {
    projectId: project.id,
    threadId: thread.id,
    messageId: a2,
    task: "Add a footer",
    provider: "anthropic",
    model: "m",
    capMicroUsd: 1_000_000,
  });
  await addModelStep(db, t, run.id, { text: "Reading", native: null, requestId, costMicroUsd: 5 });
  await addChange(db, t, {
    runId: run.id,
    stepId: null,
    path: "FOOTER.md",
    fromPath: null,
    before: null,
    after: "hi",
  });
  await addApproval(db, t, run.id, { kind: "git", runId: run.id });
  await setLive(db, t, run.id, "streaming…");
  await askToStart(db, t, {
    threadId: thread.id,
    projectId: project.id,
    task: "Again",
    model: { provider: "anthropic", id: "m" },
  });
  const schedule = await createSchedule(db, t, {
    projectId: project.id,
    name: "Nightly",
    prompt: "Check deps",
    kind: "code",
    mode: "ask",
    provider: "anthropic",
    model: "m",
    capMicroUsd: 1_000_000,
    repeat: "daily",
    onceAt: null,
    minute: 0,
    weekday: null,
  });
  await db.execute("UPDATE schedules SET last_run_id = ?, last_thread_id = ? WHERE id = ?", [
    run.id,
    thread.id,
    schedule.id,
  ]);
  await allowNetwork(db, t, { kind: "thread", id: thread.id });
  const folder = await grantFolder(db, t, "/home/me/site");
  await linkThreadFolder(db, t, thread.id, folder.id);
  const own = await addMemory(db, t, {
    text: "Prefers Marrakech tile",
    kind: "preference",
    threadId: thread.id,
  });
  await replaceChunks(db, t, "memory", own, [
    { ordinal: 0, text: "Prefers Marrakech tile", tokens: 3 },
  ]);
  const chunk =
    (await db.select<{ id: string }>("SELECT id FROM chunks WHERE source_id = ?", [own]))[0]?.id ??
    "";
  await saveVectors(db, t, "embed-1", [{ chunkId: chunk, vector: new Float32Array([1, 0]) }]);
  const cited = await addMemory(db, t, {
    text: "Kitchen budget is £4,000",
    kind: "fact",
    sourceThreadId: thread.id,
  });
  await addProposals(db, t, [
    {
      op: "add",
      memoryId: null,
      text: "Likes grey grout",
      kind: "preference",
      projectId: null,
      confidence: 90,
      sourceThreadId: thread.id,
    },
  ]);
  await addSummary(db, t, thread.id, a1b, "Quotes compared");
  await saveArtifacts(db, t, thread.id, a2, [
    {
      key: "sheet",
      title: "Costs",
      type: "markdown",
      language: "",
      content: "# Costs",
      complete: true,
    },
  ]);
  const other = await createThread(db, t, "Follow-up");
  await setThreadHandoff(db, t, other.id, thread.id);
  return { project, thread, other, run, schedule, cited, messages: { q1, a1, a1b, a1x, q2, a2 } };
}

const CHILD_TABLES = [
  "message_files",
  "message_citations",
  "message_memories",
  "run_steps",
  "run_changes",
  "run_approvals",
  "run_live",
  "run_requests",
  "runs",
  "network_grants",
  "thread_folders",
  "thread_summaries",
  "artifact_versions",
  "artifacts",
  "thread_tags",
  "imports",
  "memory_proposals",
  "chunk_vectors",
  "chunks",
];

test("a normal delete purges everything but a tombstone, and spend totals don't move", async () => {
  const db = openTestDb();
  const { project, thread, other, schedule, cited } = await fullChat(db);
  const before = await spentSince(db, t, 0, project.id);
  expect(before).toBe(1234);
  expect((await searchChats(db, t, "tile")).length).toBeGreaterThan(0);

  await purgeThread(db, t, thread.id);

  for (const table of CHILD_TABLES) expect([table, await count(db, table)]).toEqual([table, 0]);
  expect(await count(db, "messages")).toBe(0);
  expect(await count(db, "messages_fts WHERE messages_fts MATCH 'metre'")).toBe(0);
  expect(await searchChats(db, t, "tile")).toEqual([]);
  // The memory scoped to the chat is gone; the one that cited it stays, unlinked.
  const memories = await listMemoryRecords(db, t);
  expect(memories.map((m) => m.id)).toEqual([cited]);
  expect(await db.select("SELECT source_thread_id AS s FROM memories")).toEqual([{ s: null }]);
  expect(
    await db.select("SELECT last_run_id AS r, last_thread_id AS th FROM schedules WHERE id = ?", [
      schedule.id,
    ]),
  ).toEqual([{ r: null, th: null }]);
  // The tombstone: invisible, but still in its project for the spend joins.
  expect(await getThread(db, t, thread.id)).toBeNull();
  expect((await listThreads(db, t)).map((x) => x.id)).toEqual([other.id]);
  const [row] = await db.select<{
    title: string;
    project_id: string;
    kind: string;
    purged_at: number | null;
    deleted_at: number | null;
  }>("SELECT title, project_id, kind, purged_at, deleted_at FROM threads WHERE id = ?", [
    thread.id,
  ]);
  expect(row).toMatchObject({ title: "", project_id: project.id, kind: "chat" });
  expect(row?.purged_at).not.toBeNull();
  expect(row?.deleted_at).not.toBeNull();
  expect(await db.select("SELECT thread_id AS th, message_id AS m FROM request_log")).toEqual([
    { th: thread.id, m: null },
  ]);
  expect(await spentSince(db, t, 0, project.id)).toBe(before);
  expect((await getThread(db, t, other.id))?.handoffFromId).toBeNull();
  expect(await db.select("SELECT thread_id AS th FROM files")).toEqual([{ th: null }]);
  expect(fkCheck(db)).toEqual([]);
  // Running it again changes nothing and throws nothing.
  await purgeThread(db, t, thread.id);
  expect(await count(db, "threads")).toBe(2);
  // Too late to undo.
  expect(await restoreThread(db, t, thread.id)).toBe(false);
});

test("an incognito chat leaves nothing, and its spend stays unlinked", async () => {
  const db = openTestDb();
  const thread = await createThread(db, t, "Secret", null, true);
  const q = await say(db, thread.id, null, "user", "surprise");
  await logRequest(db, t, {
    threadId: thread.id,
    messageId: q,
    purpose: "chat",
    provider: "openai",
    model: "m",
    attempt: 1,
    usage: { ...EMPTY_USAGE, costMicroUsd: 7 },
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
    providerRequestId: null,
  });
  await purgeThread(db, t, thread.id, "nothing");
  expect(await count(db, "threads")).toBe(0);
  expect(await db.select("SELECT thread_id AS th FROM request_log")).toEqual([{ th: null }]);
  expect(await spentSince(db, t, 0)).toBe(7);
});

test("deleting an answer takes its re-run and later turns, leaves its sibling, and undoes", async () => {
  const db = openTestDb();
  const { thread, messages: m } = await fullChat(db);
  const { ids, previousLeafId } = await deleteMessageTree(db, t, thread.id, m.a1);
  expect([...ids].sort()).toEqual([m.a1, m.a1b, m.q2, m.a2].sort());
  expect(previousLeafId).toBe(m.a2);
  let { all, path } = await listPath(db, t, thread.id);
  expect(path.map((x) => x.id)).toEqual([m.q1, m.a1x]);
  expect(branchesOf(all, path).size).toBe(0);
  // Still in the database until purged, but out of the search results.
  expect(await count(db, "messages")).toBe(6);
  expect((await searchChats(db, t, "metre")).length).toBe(0);

  await restoreMessages(db, t, thread.id, ids, previousLeafId);
  ({ all, path } = await listPath(db, t, thread.id));
  expect(path.map((x) => x.id)).toEqual([m.q1, m.a1, m.a1b, m.q2, m.a2]);
  expect(branchesOf(all, path).get(m.a1)).toMatchObject({ position: 1, total: 2 });
});

test("deleting from a question: a middle one ends the path on the answer before it, a root with a sibling shows the other root", async () => {
  const db = openTestDb();
  const { thread, messages: m } = await fullChat(db);
  const { ids } = await deleteMessageTree(db, t, thread.id, m.q2);
  expect([...ids].sort()).toEqual([m.q2, m.a2].sort());
  expect((await listPath(db, t, thread.id)).path.map((x) => x.id)).toEqual([m.q1, m.a1, m.a1b]);

  const two = await createThread(db, t, "Two roots");
  const r1 = await say(db, two.id, null, "user", "first");
  const r1a = await say(db, two.id, r1, "assistant", "one");
  const r2 = await say(db, two.id, null, "user", "first, edited");
  const r2a = await say(db, two.id, r2, "assistant", "two");
  await setActiveLeaf(db, t, two.id, r2a);
  const gone = await deleteMessageTree(db, t, two.id, r2);
  expect([...gone.ids].sort()).toEqual([r2, r2a].sort());
  expect((await listPath(db, t, two.id)).path.map((x) => x.id)).toEqual([r1, r1a]);
  expect(await db.select("SELECT active_leaf_id AS l FROM threads WHERE id = ?", [two.id])).toEqual(
    [{ l: null }],
  );
});

test("purging messages removes their run, links and summary, unlinks what cited them, and keeps spend", async () => {
  const db = openTestDb();
  const { project, thread, messages: m } = await fullChat(db);
  const before = await spentSince(db, t, 0, project.id);
  const { ids } = await deleteMessageTree(db, t, thread.id, m.a1);
  await purgeMessages(db, t, ids);
  expect(await count(db, "messages")).toBe(2);
  expect(await count(db, "messages_fts WHERE messages_fts MATCH 'metre'")).toBe(0);
  for (const table of [
    "runs",
    "run_steps",
    "run_changes",
    "run_approvals",
    "run_live",
    "message_citations",
    "thread_summaries",
  ]) {
    expect([table, await count(db, table)]).toEqual([table, 0]);
  }
  // The file link was on q1, which stays; the artifact stays, its version unlinked from a2.
  expect(await count(db, "message_files")).toBe(1);
  expect(await db.select("SELECT message_id AS m FROM artifact_versions")).toEqual([{ m: null }]);
  expect(await db.select("SELECT message_id AS m, thread_id AS th FROM request_log")).toEqual([
    { m: null, th: thread.id },
  ]);
  expect(await db.select("SELECT last_run_id AS r FROM schedules")).toEqual([{ r: null }]);
  expect(await spentSince(db, t, 0, project.id)).toBe(before);
  expect(fkCheck(db)).toEqual([]);
  await purgeMessages(db, t, ids);
  expect(await count(db, "messages")).toBe(2);
});

test("the startup sweep purges what was deleted but not yet purged, and skips tombstones", async () => {
  const db = openTestDb();
  const { thread, other, messages: m } = await fullChat(db);
  const done = await createThread(db, t, "Already gone");
  await deleteThread(db, t, done.id);
  await purgeThread(db, t, done.id);
  await deleteThread(db, t, thread.id);
  const q = await say(db, other.id, null, "user", "keep me");
  const a = await say(db, other.id, q, "assistant", "dropped");
  await setActiveLeaf(db, t, other.id, a);
  await deleteMessageTree(db, t, other.id, a);

  expect(await sweepDeleted(db, t)).toEqual({ threads: 1, messages: 1 });
  expect(await count(db, "messages WHERE thread_id = ?", [thread.id])).toBe(0);
  expect(await count(db, "messages WHERE thread_id = ?", [other.id])).toBe(1);
  expect(await count(db, "threads WHERE purged_at IS NOT NULL")).toBe(2);
  expect(fkCheck(db)).toEqual([]);
  expect(await sweepDeleted(db, t)).toEqual({ threads: 0, messages: 0 });
  // An undo before the sweep would have kept it.
  expect(m.a1).toBeTruthy();
});
