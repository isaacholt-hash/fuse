// @vitest-environment node
import type { continueChatRun, startChatRun } from "@/agent/chatRun";
import type { ApprovalAnswer, RunDeps } from "@/agent/run";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { DEFAULT_TENANT } from "@/storage/defaults";
import {
  addApproval,
  answerApproval,
  askToContinue,
  askToStart,
  askToStop,
  getLive,
  getRequest,
  openApprovals,
  takeRequest,
} from "@/storage/runQueue";
import { createRun, getRun, setRunStatus, type Run } from "@/storage/runs";
import type { SqlDb } from "@/storage/sql";
import { openTestDb } from "@/storage/testing/nodeDb";
import { Runner } from "./runner";

const t = DEFAULT_TENANT;
const model =
  defaultCatalog.models.find((m) => m.provider === "anthropic") ?? defaultCatalog.models[0];
if (!model) throw new Error("no model in the catalog");
const ref = { provider: model.provider, id: model.id };

function depsFor(db: SqlDb): () => Promise<RunDeps> {
  return () =>
    Promise.resolve({
      db,
      tenant: t,
      catalog: defaultCatalog,
      adapterFor: () => {
        throw new Error("no provider in these tests");
      },
      repo: {} as RunDeps["repo"],
    });
}

/** Until `check` holds, letting the runner's promises go on. */
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
}

/** A chat run that streams, asks once, and is done on yes or stopped on anything else. */
const askingRun: typeof startChatRun = async (deps, input) => {
  const run = await createRun(deps.db, deps.tenant, {
    projectId: null,
    threadId: null,
    messageId: null,
    task: input.task,
    provider: input.model.provider,
    model: input.model.id,
    capMicroUsd: 1_000_000,
  });
  input.onProgress?.("answer", { run, steps: [], changes: [], streaming: "Looking around" });
  const answer: boolean | ApprovalAnswer = await (deps.approve?.({
    kind: "command",
    command: "ls",
    runId: run.id,
    ...(input.signal ? { signal: input.signal } : {}),
  }) ?? Promise.resolve("no"));
  await setRunStatus(deps.db, deps.tenant, run.id, answer === "yes" ? "done" : "stopped");
  return (await getRun(deps.db, deps.tenant, run.id)) as Run;
};

const fast = { pollMs: 1, liveMs: 0, sleep: () => new Promise<void>((r) => setTimeout(r, 1)) };

test("a run asked for by a page runs here, waits for an answer from any page, and finishes", async () => {
  const db = openTestDb();
  const runner = new Runner({ deps: depsFor(db), start: askingRun, ...fast });
  const req = await askToStart(db, t, {
    threadId: "t1",
    projectId: null,
    task: "tidy up",
    model: ref,
  });
  await runner.tick();

  // Waiting for you: the question is in the database, and the request knows its run.
  await until(async () => (await openApprovals(db, t)).length === 1);
  const [question] = await openApprovals<{ kind: string; command: string; signal?: unknown }>(
    db,
    t,
  );
  expect(question?.request).toMatchObject({ kind: "command", command: "ls" });
  expect(question?.request.signal).toBeUndefined();
  const asked = await getRequest(db, t, req);
  expect(asked).toMatchObject({ status: "done", runId: question?.runId });
  expect(await getLive(db, t, question?.runId ?? "")).toBe("Looking around");
  expect(runner.going.has(question?.runId ?? "")).toBe(true);

  // Answered from another page; a second answer doesn't count.
  expect(await answerApproval(db, t, question?.id ?? "", "yes")).toBe(true);
  expect(await answerApproval(db, t, question?.id ?? "", "no")).toBe(false);
  await runner.idle();
  expect((await getRun(db, t, question?.runId ?? ""))?.status).toBe("done");
  expect(runner.going.size).toBe(0);
  expect(await getLive(db, t, question?.runId ?? "")).toBe("");
});

test("Stop from a page reaches a run waiting here, and its question counts as no", async () => {
  const db = openTestDb();
  const runner = new Runner({ deps: depsFor(db), start: askingRun, ...fast });
  await askToStart(db, t, { threadId: "t1", projectId: null, task: "x", model: ref });
  await runner.tick();
  await until(async () => (await openApprovals(db, t)).length === 1);
  const runId = [...runner.going.keys()][0] ?? "";
  await askToStop(db, t, runId);
  await runner.tick();
  await runner.idle();
  expect((await getRun(db, t, runId))?.status).toBe("stopped");
  expect(await openApprovals(db, t)).toEqual([]);
});

test("Continue goes on with a stopped run, raising its cap when asked", async () => {
  const db = openTestDb();
  const run = await createRun(db, t, {
    projectId: null,
    threadId: null,
    messageId: null,
    task: "x",
    provider: ref.provider,
    model: ref.id,
    capMicroUsd: 1,
  });
  await setRunStatus(db, t, run.id, "paused");
  const calls: { runId: string; raiseCapBy?: number }[] = [];
  const fakeContinue: typeof continueChatRun = async (deps, runId, input) => {
    calls.push({ runId, ...(input.raiseCapBy ? { raiseCapBy: input.raiseCapBy } : {}) });
    await setRunStatus(deps.db, deps.tenant, runId, "done");
    return (await getRun(deps.db, deps.tenant, runId)) as Run;
  };
  const runner = new Runner({ deps: depsFor(db), continue: fakeContinue, ...fast });
  await askToContinue(db, t, run.id, 500_000);
  await runner.tick();
  await runner.idle();
  expect(calls).toEqual([{ runId: run.id, raiseCapBy: 500_000 }]);
  expect((await getRun(db, t, run.id))?.status).toBe("done");
});

test("a model that isn't in the catalog fails the request, not the runner", async () => {
  const db = openTestDb();
  const runner = new Runner({ deps: depsFor(db), start: askingRun, ...fast });
  const req = await askToStart(db, t, {
    threadId: "t1",
    projectId: null,
    task: "x",
    model: { provider: "openai", id: "not-a-model" },
  });
  await runner.tick();
  expect(await getRequest(db, t, req)).toMatchObject({
    status: "failed",
    error: "The model openai/not-a-model isn't in FUSE's list.",
  });
});

test("after a restart: runs that were going are stopped, taken requests fail, open questions are no", async () => {
  const db = openTestDb();
  const run = await createRun(db, t, {
    projectId: null,
    threadId: null,
    messageId: null,
    task: "x",
    provider: ref.provider,
    model: ref.id,
    capMicroUsd: 1,
  });
  const req = await askToStart(db, t, { threadId: "t1", projectId: null, task: "y", model: ref });
  await takeRequest(db, t);
  await addApproval(db, t, run.id, { kind: "command", command: "ls" });

  await new Runner({ deps: depsFor(db), ...fast }).recover();
  expect(await getRun(db, t, run.id)).toMatchObject({
    status: "stopped",
    note: "FUSE closed while it was working.",
  });
  expect(await getRequest(db, t, req)).toMatchObject({
    status: "failed",
    error: "The server restarted.",
  });
  expect(await openApprovals(db, t)).toEqual([]);
});

test("a request is taken once, oldest first", async () => {
  const db = openTestDb();
  const a = await askToStop(db, t, "r1");
  const b = await askToStop(db, t, "r2");
  expect((await takeRequest(db, t))?.id).toBe(a);
  expect((await takeRequest(db, t))?.id).toBe(b);
  expect(await takeRequest(db, t)).toBeNull();
});
