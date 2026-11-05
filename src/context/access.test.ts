// @vitest-environment node
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { createProject } from "@/storage/projects";
import { createThread, setThreadMemory, setThreadProject } from "@/storage/threads";
import { setEgressRule } from "@/storage/egress";
import { switchProjectTool } from "@/storage/projectTools";
import { createRun } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { requireContext, contextGuard, type ContextOwner } from "./access";

async function setup() {
  const db = openTestDb();
  const project = await createProject(db, tenant, "Recorded context");
  const thread = await createThread(db, tenant, "Context", project.id);
  const owner: ContextOwner = {
    threadId: thread.id,
    projectId: project.id,
    runId: null,
    messageId: null,
    provider: "openai",
    model: "recorded",
    callKey: "recorded-call",
  };
  return { db, deps: { db, tenant }, project, thread, owner };
}

test("context tools recheck live provider, project, memory and tool settings", async () => {
  const { db, deps, project, thread, owner } = await setup();
  await expect(requireContext(deps, owner, "read_memory", true)).resolves.toBeDefined();
  await setThreadMemory(db, tenant, thread.id, false);
  await expect(requireContext(deps, owner, "read_memory", true)).rejects.toThrow("setting changed");
  await expect(requireContext(deps, owner, "read_artifact")).resolves.toBeDefined();
  await switchProjectTool(db, tenant, project.id, "read_artifact", false);
  await expect(requireContext(deps, owner, "read_artifact")).rejects.toThrow();
  await setEgressRule(db, tenant, project.id, "openai", false);
  await expect(requireContext(deps, owner, "search_artifacts")).rejects.toThrow();
});

test("incognito, device-only, deleted and moved sources cannot supply context", async () => {
  const { db, deps, thread, owner } = await setup();
  for (const column of ["incognito", "local_only"] as const) {
    await db.execute(`UPDATE threads SET ${column}=1 WHERE id=?`, [thread.id]);
    await expect(requireContext(deps, owner, "read_artifact")).rejects.toThrow();
    await db.execute(`UPDATE threads SET ${column}=0 WHERE id=?`, [thread.id]);
  }
  const other = await createProject(db, tenant, "Different scope");
  await setThreadProject(db, tenant, thread.id, other.id);
  await expect(requireContext(deps, owner, "read_artifact")).rejects.toThrow();
  await db.execute("UPDATE threads SET deleted_at=1 WHERE id=?", [thread.id]);
  await expect(
    requireContext(deps, { ...owner, projectId: other.id }, "read_artifact"),
  ).rejects.toThrow();
});

test("the same guard works atomically in a batch and rejects stopped/replicated runs", async () => {
  const { db, deps, thread, project, owner } = await setup();
  const run = await createRun(db, tenant, {
    projectId: project.id,
    threadId: thread.id,
    messageId: null,
    task: "Recorded context",
    provider: "openai",
    model: "recorded",
    capMicroUsd: 1_000_000,
    mode: "ask",
  });
  const current = { ...owner, runId: run.id };
  await expect(requireContext(deps, current, "propose_memory", true, true)).resolves.toBeDefined();
  const guard = contextGuard(deps, current, "propose_memory", true, true);
  await db.execute("UPDATE runs SET status='stopped' WHERE id=?", [run.id]);
  const changed = await db.batch([
    {
      sql: `UPDATE threads SET title='must not change' WHERE id=? AND ${guard.sql}`,
      params: [thread.id, ...guard.params],
    },
  ]);
  expect(changed[0]?.rowsAffected).toBe(0);
  await db.execute("UPDATE runs SET status='running',sync_owner='different-device' WHERE id=?", [
    run.id,
  ]);
  await expect(requireContext(deps, current, "propose_memory", true, true)).rejects.toThrow();
  await expect(
    requireContext(deps, { ...owner, provider: "local" }, "read_artifact"),
  ).rejects.toThrow("housekeeping");
});
