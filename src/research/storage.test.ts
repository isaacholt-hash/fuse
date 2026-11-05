// @vitest-environment node
import { reserveRequest, dispatchRequest } from "@/storage/requestBudget";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { createRun, getRun, setRunStatus } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { fixtureState } from "./testing/fixtures";
import { createThread } from "@/storage/threads";
import { addMessage, listMessages } from "@/storage/messages";
import {
  beginOperation,
  checkpoint,
  claim,
  completeOperation,
  initialize,
  operations,
  park,
  requestControl,
  save,
} from "./storage";

async function setup() {
  const db = openTestDb();
  const deps = { db, tenant };
  const make = async () => {
    const run = await createRun(db, tenant, {
      projectId: null,
      threadId: null,
      messageId: null,
      task: "Research",
      kind: "research",
      provider: "openai",
      model: "fixture",
      capMicroUsd: 1_000_000,
    });
    await initialize(deps, run.id, fixtureState());
    return run;
  };
  const run = await make();
  return { db, deps, run, make };
}

test("one execution owner claims a research run; saving never changes another run", async () => {
  const { deps, run, make } = await setup();
  const other = await make();
  const claims = await Promise.allSettled([claim(deps, run.id), claim(deps, run.id)]);
  expect(claims.filter((c) => c.status === "fulfilled")).toHaveLength(1);
  const lease = claims.find((c) => c.status === "fulfilled");
  if (lease?.status !== "fulfilled") throw new Error("Missing lease");
  const state = { ...fixtureState(), searches: 1 };
  await save(deps, run.id, lease.value, state);
  expect((await checkpoint(deps, run.id)).state.searches).toBe(1);
  expect((await checkpoint(deps, other.id)).state.searches).toBe(0);
  await expect(save(deps, run.id, "other-owner", fixtureState())).rejects.toThrow("ownership");
});

test("a completed source step and next checkpoint commit together, with no duplicate delivery", async () => {
  const { db, deps, run } = await setup();
  const lease = await claim(deps, run.id);
  const before = { ...fixtureState(), reads: 1 };
  const id = await beginOperation(deps, run.id, lease, before, "read", {
    url: "https://example.com/",
  });
  expect((await operations(deps, run.id))[0]).toMatchObject({ id, state: "pending", seq: 1 });
  const after = { ...before, stage: "synthesis" as const };
  db.raw.exec(
    "CREATE TRIGGER fixture_reject BEFORE INSERT ON run_steps BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  await expect(
    completeOperation(
      deps,
      run.id,
      lease,
      after,
      id,
      { text: "Evidence" },
      { url: "https://example.com/", output: "Evidence" },
    ),
  ).rejects.toThrow("fixture");
  expect((await checkpoint(deps, run.id)).state.stage).toBe("plan");
  expect((await operations(deps, run.id))[0]?.state).toBe("pending");
  expect(await db.select("SELECT id FROM run_steps")).toHaveLength(0);
  db.raw.exec("DROP TRIGGER fixture_reject");
  await completeOperation(
    deps,
    run.id,
    lease,
    after,
    id,
    { text: "Evidence" },
    { url: "https://example.com/", output: "Evidence" },
  );
  expect((await checkpoint(deps, run.id)).state.stage).toBe("synthesis");
  expect((await operations(deps, run.id))[0]?.state).toBe("complete");
  expect(await db.select("SELECT tool_name,output FROM run_steps")).toEqual([
    { tool_name: "fetch_url", output: "Evidence" },
  ]);
  await expect(
    completeOperation(
      deps,
      run.id,
      lease,
      after,
      id,
      {},
      { url: "https://example.com/", output: "Changed" },
    ),
  ).rejects.toThrow("already committed");
  expect(await db.select("SELECT output FROM run_steps")).toEqual([{ output: "Evidence" }]);
});

test("pause/stop controls stay on the owner and parking releases the claim atomically", async () => {
  const { db, deps, run } = await setup();
  const lease = await claim(deps, run.id);
  await requestControl(deps, run.id, "pause");
  expect((await checkpoint(deps, run.id)).pause).toBe(true);
  await park(deps, run.id, lease, fixtureState(), "paused", "Paused safely");
  expect(await getRun(db, tenant, run.id)).toMatchObject({
    status: "paused",
    note: "Paused safely",
  });
  expect((await checkpoint(deps, run.id)).lease).toBeNull();
  const resumed = await claim(deps, run.id);
  expect(resumed).not.toBe(lease);
  expect((await checkpoint(deps, run.id)).pause).toBe(false);
  await requestControl(deps, run.id, "stop");
  expect((await checkpoint(deps, run.id)).stop).toBe(true);
  await setRunStatus(db, tenant, run.id, "stopped", "Interrupted");
  await db.execute("UPDATE runs SET sync_owner='another-device' WHERE id=?", [run.id]);
  await expect(claim(deps, run.id)).rejects.toThrow("owned");
});

test("checkpoint schema errors preserve pending work and cascading deletion removes local journals", async () => {
  const { db, deps, run } = await setup();
  const lease = await claim(deps, run.id);
  await beginOperation(deps, run.id, lease, fixtureState(), "plan", {});
  await db.execute("UPDATE research_state SET data=? WHERE run_id=?", [
    JSON.stringify({ ...fixtureState(), version: 2 }),
    run.id,
  ]);
  await expect(checkpoint(deps, run.id)).rejects.toThrow("incompatible");
  expect(await operations(deps, run.id)).toHaveLength(1);
  await db.execute("DELETE FROM runs WHERE id=?", [run.id]);
  expect(await db.select("SELECT run_id FROM research_state")).toEqual([]);
  expect(await db.select("SELECT run_id FROM research_operations")).toEqual([]);
});

test.each(["pause", "stop"] as const)(
  "%s wins atomically before operation creation or an already-held dispatch",
  async (action) => {
    const { db, deps, run } = await setup();
    const lease = await claim(deps, run.id);
    expect(
      await reserveRequest(db, tenant, {
        id: "held",
        runId: run.id,
        provider: "openai",
        model: "fixture",
        purpose: "agent",
        threadId: null,
        messageId: null,
        boundMicroUsd: 100,
      }),
    ).toBe(true);
    await requestControl(deps, run.id, action);
    await expect(
      beginOperation(deps, run.id, lease, { ...fixtureState(), modelCalls: 1 }, "plan", {}),
    ).rejects.toThrow("could not claim");
    expect((await checkpoint(deps, run.id)).state.modelCalls).toBe(0);
    expect(await operations(deps, run.id)).toEqual([]);
    expect(await dispatchRequest(db, tenant, "held")).toBe(false);
  },
);

test("initial pause/stop controls survive the first execution claim", async () => {
  const { deps, run } = await setup();
  await requestControl(deps, run.id, "pause");
  await requestControl(deps, run.id, "stop");
  await claim(deps, run.id);
  expect(await checkpoint(deps, run.id)).toMatchObject({ pause: true, stop: true });
});

test("a stale owner cannot park over a status changed by the current owner", async () => {
  const { db, deps, run } = await setup();
  const lease = await claim(deps, run.id);
  await db.execute("UPDATE runs SET status='stopped',note='Current owner' WHERE id=?", [run.id]);
  await expect(
    park(deps, run.id, lease, { ...fixtureState(), modelCalls: 3 }, "done", "Old owner"),
  ).rejects.toThrow("ownership");
  expect(await getRun(db, tenant, run.id)).toMatchObject({
    status: "stopped",
    note: "Current owner",
  });
  expect((await checkpoint(deps, run.id)).state.modelCalls).toBe(0);
});

test("a stale publication cannot write an artifact, message, checkpoint or replication event", async () => {
  const { db, deps, run } = await setup();
  const thread = await createThread(db, tenant);
  const messageId = await addMessage(db, tenant, {
    threadId: thread.id,
    parentId: null,
    role: "assistant",
    content: "Current owner's text",
  });
  const lease = await claim(deps, run.id);
  await db.execute("UPDATE research_state SET lease='current-owner' WHERE run_id=?", [run.id]);
  await db.execute("UPDATE sync_state SET enabled=1");
  const outbox = await db.select("SELECT * FROM sync_outbox ORDER BY seq");
  await expect(
    park(deps, run.id, lease, { ...fixtureState(), stage: "finished" }, "done", null, {
      messageId,
      message: { content: "Stale text", status: "complete" },
      artifact: { threadId: thread.id, key: `research-${run.id}`, content: "Stale report" },
    }),
  ).rejects.toThrow("ownership");
  expect((await listMessages(db, tenant, thread.id))[0]?.content).toBe("Current owner's text");
  expect(await db.select("SELECT id FROM artifacts")).toEqual([]);
  expect(await db.select("SELECT * FROM sync_outbox ORDER BY seq")).toEqual(outbox);
  expect((await checkpoint(deps, run.id)).lease).toBe("current-owner");
});
