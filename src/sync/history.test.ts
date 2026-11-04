// @vitest-environment node
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { openTestDb } from "@/storage/testing/nodeDb";
import { addMemory, listMemories, listMemoryRecords } from "@/storage/memories";
import { assertRunWritable, createRun, getRun } from "@/storage/runs";

test("unresolved memories stay reviewable but cannot enter the active model context", async () => {
  const db = openTestDb();
  const id = await addMemory(db, tenant, { text: "Synthetic fact", kind: "fact" });
  await db.execute(
    "INSERT INTO sync_conflicts(id,workspace_id,user_id,table_name,record_key,ours,theirs,created_at,updated_at) VALUES ('conflict',?,?,'memories',?,'{}','{}',1,1)",
    [tenant.workspaceId, tenant.userId, id],
  );
  expect(await listMemories(db, tenant)).toEqual([]);
  expect(await listMemoryRecords(db, tenant)).toHaveLength(1);
  await db.execute("UPDATE sync_conflicts SET resolved_at=1");
  expect(await listMemories(db, tenant)).toHaveLength(1);
});

test("a foreign run snapshot is read-only before a folder or execution path is selected", async () => {
  const db = openTestDb();
  const run = await createRun(db, tenant, {
    projectId: null,
    threadId: null,
    messageId: null,
    task: "Synthetic run",
    provider: "fixture",
    model: "fixture",
    capMicroUsd: 1000,
  });
  await expect(assertRunWritable(db, tenant, run.id)).resolves.toBeUndefined();
  await db.execute("UPDATE runs SET status='done',sync_owner='other-installation' WHERE id=?", [
    run.id,
  ]);
  expect((await getRun(db, tenant, run.id))?.readOnly).toBe(true);
  await expect(assertRunWritable(db, tenant, run.id)).rejects.toThrow("read-only");
  await db.execute("UPDATE runs SET sync_owner=(SELECT device_id FROM sync_state) WHERE id=?", [
    run.id,
  ]);
  await expect(assertRunWritable(db, tenant, run.id)).resolves.toBeUndefined();
});
