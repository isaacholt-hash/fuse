// @vitest-environment node
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createRun, getRun, listSteps, markInterruptedRuns } from "@/storage/runs";
import { interruptChildren, recoverChildResults } from "./storage";
import { childTasks } from "./tool";

async function fixture(state = "ready") {
  const db = openTestDb();
  const input = {
    projectId: null,
    threadId: null,
    messageId: null,
    task: "Recorded parent",
    provider: "openai",
    model: "fixture",
    capMicroUsd: 1000,
  };
  const parent = await createRun(db, tenant, input);
  const child = await createRun(db, tenant, { ...input, task: "Recorded child" });
  await db.execute("UPDATE runs SET parent_run_id=?,status=? WHERE id=?", [
    parent.id,
    state === "running" ? "running" : "paused",
    child.id,
  ]);
  await db.execute(
    "INSERT INTO run_steps(id,workspace_id,user_id,run_id,seq,kind,created_at,updated_at) VALUES('parent-model',?,?,?,1,'model',1,1)",
    [tenant.workspaceId, tenant.userId, parent.id],
  );
  await db.execute(
    "INSERT INTO code_children(child_id,workspace_id,user_id,parent_id,dispatch_id,model_step_id,call_id,request,ordinal,base_revision,path,state,created_at,updated_at) VALUES(?,?,?,?,'dispatch','parent-model','delegation',?,0,?,?,?,1,1)",
    [
      child.id,
      tenant.workspaceId,
      tenant.userId,
      parent.id,
      JSON.stringify({ tasks: ["An explicit task"] }),
      "a".repeat(40),
      "/recorded/private-worktree",
      state,
    ],
  );
  return { db, parent, child };
}

test.each(["creating", "ready", "running"])(
  "startup interrupts %s child work without dispatch or losing recovery evidence",
  async (state) => {
    const { db, parent, child } = await fixture(state);
    await markInterruptedRuns(db, tenant);
    expect((await getRun(db, tenant, parent.id))?.status).toBe("stopped");
    expect((await getRun(db, tenant, child.id))?.status).toBe("stopped");
    expect(await db.select("SELECT state,path FROM code_children")).toEqual([
      { state: "interrupted", path: "/recorded/private-worktree" },
    ]);
    expect(await db.select("SELECT id FROM request_log")).toEqual([]);
    expect(await listSteps(db, tenant, parent.id)).toHaveLength(1);
    await recoverChildResults(db, tenant, parent.id);
    await recoverChildResults(db, tenant, parent.id);
    const steps = await listSteps(db, tenant, parent.id);
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({
      kind: "tool",
      call: { id: "delegation", name: "delegate_code" },
      isError: true,
      approval: "you",
    });
    expect(steps[1]?.kind === "tool" && steps[1].output).toContain('"replayed":false');
    expect(await db.select("SELECT state FROM code_children")).toEqual([{ state: "interrupted" }]);
  },
);

test("a live child has no synthetic recovery result and foreign ownership is never reclaimed", async () => {
  const { db, parent } = await fixture("running");
  await recoverChildResults(db, tenant, parent.id);
  expect(await listSteps(db, tenant, parent.id)).toHaveLength(1);
  await db.execute("UPDATE runs SET sync_owner='another-device' WHERE id=?", [parent.id]);
  await interruptChildren(db, tenant);
  expect(await db.select("SELECT state FROM code_children")).toEqual([{ state: "running" }]);
});

test("delegation validates counts, binary/text bounds and excludes caller-selected authority", () => {
  expect(childTasks({ tasks: ["One task", "Another task"] })).toEqual(["One task", "Another task"]);
  for (const tasks of [
    [],
    [""],
    [" "],
    ["a\0b"],
    [1],
    ["a", "b", "c", "d"],
    ["語".repeat(6000)],
    ["x".repeat(12000), "y".repeat(12000), "z".repeat(12000)],
  ])
    expect(() => childTasks({ tasks })).toThrow();
  expect(() => childTasks({ tasks: ["Task"], owner: "another-device" })).toThrow();
  expect(() => childTasks({ tasks: ["Task"], folder: "/outside" })).toThrow();
});
