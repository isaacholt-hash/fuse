// @vitest-environment node
// M10 steps 6 and 8: the web app's Runs list, its badge, and the cheap per-second check.
import { DEFAULT_TENANT } from "./defaults";
import { addMessage } from "./messages";
import { createRun, recentRuns, runStatesForThread, runsEndedSince, setRunStatus } from "./runs";
import { openTestDb } from "./testing/nodeDb";
import { createThread } from "./threads";

const t = DEFAULT_TENANT;

async function aRun(db: ReturnType<typeof openTestDb>, threadId: string | null, task: string) {
  const messageId = threadId
    ? await addMessage(db, t, { threadId, parentId: null, role: "assistant", content: "" })
    : null;
  return createRun(db, t, {
    projectId: null,
    threadId,
    messageId,
    task,
    provider: "anthropic",
    model: "m",
    capMicroUsd: 1_000_000,
  });
}

test("recent runs come newest first with their chat's title; ended ones are counted after a time", async () => {
  const db = openTestDb();
  const chat = await createThread(db, t, "Lighthouse docs");
  const first = await aRun(db, chat.id, "Write the README");
  await new Promise((r) => setTimeout(r, 2));
  const second = await aRun(db, null, "Tidy the downloads");
  const before = Date.now();
  await new Promise((r) => setTimeout(r, 2));
  await setRunStatus(db, t, first.id, "error", "No Anthropic key yet.");

  const list = await recentRuns(db, t);
  expect(list.map((r) => [r.task, r.threadTitle, r.status, r.note])).toEqual([
    ["Write the README", "Lighthouse docs", "error", "No Anthropic key yet."],
    ["Tidy the downloads", null, "running", null],
  ]);
  expect(await recentRuns(db, t, 1)).toHaveLength(1);

  expect(await runsEndedSince(db, t, 0)).toBe(1);
  expect(await runsEndedSince(db, t, Date.now() + 1)).toBe(0);
  await setRunStatus(db, t, second.id, "stopped");
  // Stopped isn't "finished or failed".
  expect(await runsEndedSince(db, t, before)).toBe(1);

  expect(await runStatesForThread(db, t, chat.id)).toEqual([
    {
      id: first.id,
      messageId: first.messageId,
      status: "error",
      updatedAt: expect.any(Number) as number,
    },
  ]);
});

test("M10 step 13: each thread's latest run, in one query", async () => {
  const db = openTestDb();
  const a = await createThread(db, t, "A");
  const b = await createThread(db, t, "B");
  const make = (threadId: string, task: string) =>
    createRun(db, t, {
      projectId: null,
      threadId,
      messageId: null,
      task,
      provider: "anthropic",
      model: "m",
      capMicroUsd: 1,
    });
  const first = await make(a.id, "one");
  await setRunStatus(db, t, first.id, "done");
  await new Promise((r) => setTimeout(r, 2));
  const second = await make(a.id, "two");
  const other = await make(b.id, "three");
  await setRunStatus(db, t, other.id, "error");
  const { latestRunByThread } = await import("./runs");
  const latest = await latestRunByThread(db, t);
  expect(latest.get(a.id)).toMatchObject({ runId: second.id, status: "running" });
  expect(latest.get(b.id)).toMatchObject({ runId: other.id, status: "error" });
  expect(latest.size).toBe(2);
});
