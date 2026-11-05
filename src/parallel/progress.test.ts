// @vitest-environment node
import { openTestDb } from "@/storage/testing/nodeDb";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { createRun, getRun } from "@/storage/runs";
import { reserveRequest } from "@/storage/requestBudget";
import { parallelProgress, stopParallelChild } from "./progress";

async function fixture() {
  const db = openTestDb();
  const input = {
    projectId: null,
    threadId: null,
    messageId: null,
    task: "Parent",
    provider: "openai",
    model: "fixture",
    capMicroUsd: 5000,
  };
  const parent = await createRun(db, tenant, input);
  const child = await createRun(db, tenant, {
    ...input,
    task: "\nChild task approved through the parent run. Rules.\n\nWrite alpha.\n\nPreserve this paragraph.",
  });
  await db.execute("UPDATE runs SET parent_run_id=?,spent_micro_usd=200 WHERE id=?", [
    parent.id,
    child.id,
  ]);
  await db.execute("UPDATE runs SET spent_micro_usd=300 WHERE id=?", [parent.id]);
  return { db, parent, child };
}

it("progress shows one combined total, root/sibling holds and the complete approved task without double counting child costs", async () => {
  const { db, parent, child } = await fixture();
  for (const [id, runId, bound] of [
    ["root-hold", parent.id, 40],
    ["child-hold", child.id, 70],
  ] as const) {
    expect(
      await reserveRequest(db, tenant, {
        id,
        runId,
        provider: "openai",
        model: "fixture",
        purpose: "agent",
        boundMicroUsd: bound,
        threadId: null,
        messageId: null,
      }),
    ).toBe(true);
  }
  await db.execute("UPDATE request_reservations SET state='unknown' WHERE id='child-hold'");
  const result = (await parallelProgress(db, tenant, [parent.id])).get(parent.id);
  expect(result).toMatchObject({ spentMicroUsd: 300, heldMicroUsd: 110, capMicroUsd: 5000 });
  expect(result?.children).toEqual([
    expect.objectContaining({
      id: child.id,
      task: "Write alpha.\n\nPreserve this paragraph.",
      spentMicroUsd: 200,
    }),
  ]);
  expect(await parallelProgress(db, tenant, [])).toEqual(new Map());
  expect(await parallelProgress(db, { ...tenant, userId: "foreign-user" }, [parent.id])).toEqual(
    new Map(),
  );
});

it("a stop belongs to the exact running child and owner; stale, sibling and foreign writes fail closed", async () => {
  const { db, parent, child } = await fixture();
  expect(await stopParallelChild(db, tenant, "wrong-parent", child.id)).toBe(false);
  await db.execute("UPDATE runs SET sync_owner='foreign-owner' WHERE id=?", [parent.id]);
  expect(await stopParallelChild(db, tenant, parent.id, child.id)).toBe(false);
  expect((await getRun(db, tenant, child.id))?.status).toBe("running");
  await db.execute("UPDATE runs SET sync_owner=NULL WHERE id=?", [parent.id]);
  expect(await stopParallelChild(db, tenant, parent.id, child.id)).toBe(true);
  expect(await stopParallelChild(db, tenant, parent.id, child.id)).toBe(false);
  expect((await getRun(db, tenant, child.id))?.status).toBe("stopped");
  expect(await db.select("SELECT id FROM request_log")).toEqual([]);
});
