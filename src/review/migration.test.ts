// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { migrationFiles, openTestDb } from "@/storage/testing/nodeDb";
import { DEFAULT_TENANT as t } from "@/storage/defaults";
import { createRun, setRunStatus } from "@/storage/runs";
import { DELETE_ORDER } from "@/data/deleteAll";
import { EXPORTED_TABLES } from "@/data/exportAll";
import { syncRegistry } from "@/sync/registry";
test("schema 68 preserves populated history and pending sync while marking existing runs ordinary", () => {
  const db = new DatabaseSync(":memory:");
  const sql = (name: string) =>
    readFileSync(new URL(`../../src-tauri/migrations/${name}`, import.meta.url), "utf8");
  for (const name of migrationFiles().filter((f) => f < "0068")) db.exec(sql(name));
  db.exec("UPDATE sync_state SET enabled=1");
  db.prepare(
    "INSERT INTO runs(id,workspace_id,user_id,task,mode,provider,model,status,cap_micro_usd,spent_micro_usd,created_at,updated_at) VALUES('existing',?,?,'Kept history','plan','anthropic','fixture','done',100000,123,1,2)",
  ).run(t.workspaceId, t.userId);
  const before = db.prepare("SELECT * FROM runs").all(),
    outbox = db.prepare("SELECT * FROM sync_outbox ORDER BY seq").all();
  db.exec("BEGIN IMMEDIATE");
  db.exec(sql("0068_code_review.sql"));
  db.exec("COMMIT");
  expect(db.prepare("SELECT * FROM runs").all()).toEqual(
    before.map((r) => ({ ...r, review_profile: 0 })),
  );
  expect(db.prepare("SELECT * FROM sync_outbox ORDER BY seq").all()).toEqual(outbox);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  for (const table of ["review_state", "review_operations"]) {
    expect(syncRegistry.localTables).toHaveProperty(table);
    expect(EXPORTED_TABLES).not.toContain(table);
    expect(DELETE_ORDER.indexOf(table as (typeof DELETE_ORDER)[number])).toBeLessThan(
      DELETE_ORDER.indexOf("runs"),
    );
  }
  db.close();
});
test("completed history carries the read-only review profile without source bytes or execution state", async () => {
  const db = openTestDb();
  await db.execute("UPDATE sync_state SET enabled=1");
  const run = await createRun(db, t, {
    projectId: null,
    threadId: null,
    messageId: null,
    task: "Review fixture",
    provider: "anthropic",
    model: "fixture",
    capMicroUsd: 100000,
    review: true,
  });
  await db.execute(
    "INSERT INTO review_state(run_id,workspace_id,user_id,data,created_at,updated_at) VALUES(?,?,?,?,1,1)",
    [
      run.id,
      t.workspaceId,
      t.userId,
      JSON.stringify({ privateSnapshot: "synthetic repository bytes" }),
    ],
  );
  await setRunStatus(db, t, run.id, "done");
  const events = await db.select<{ table_name: string; payload: string | null }>(
    "SELECT table_name,payload FROM sync_outbox WHERE operation='put'",
  );
  expect(
    events
      .filter((r) => r.table_name === "runs")
      .map((r) => JSON.parse(r.payload ?? "{}") as unknown),
  ).toContainEqual(expect.objectContaining({ review_profile: 1 }));
  expect(JSON.stringify(events)).not.toContain("synthetic repository bytes");
  expect(
    events.some(
      (r) =>
        r.table_name === "review_state" ||
        r.table_name === "review_operations" ||
        r.table_name === "run_requests",
    ),
  ).toBe(false);
});
