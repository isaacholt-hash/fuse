// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { migrationFiles } from "@/storage/testing/nodeDb";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";

test("schema 64 preserves populated runs, dependencies and pending events without recapture", () => {
  const db = new DatabaseSync(":memory:");
  const sql = (file: string) =>
    readFileSync(new URL(`../../src-tauri/migrations/${file}`, import.meta.url), "utf8");
  for (const file of migrationFiles().filter((f) => f < "0064")) db.exec(sql(file));
  const { workspaceId: ws, userId: user } = tenant;
  db.exec("UPDATE sync_state SET enabled=1");
  db.prepare(
    "INSERT INTO projects(id,workspace_id,user_id,name,created_at,updated_at) VALUES('p',?,?,'Fixture',1,1)",
  ).run(ws, user);
  db.prepare(
    "INSERT INTO runs(id,workspace_id,user_id,project_id,task,kind,mode,provider,model,status,cap_micro_usd,spent_micro_usd,created_at,updated_at,plan,planner) VALUES('r',?,?,'p','Fixture','work','plan','anthropic','fixture','done',5000000,12345,1,2,'Plan','anthropic/fixture')",
  ).run(ws, user);
  db.prepare(
    "INSERT INTO run_steps(id,workspace_id,user_id,run_id,seq,kind,text,created_at,updated_at) VALUES('s',?,?,'r',1,'model','Answer',1,2)",
  ).run(ws, user);
  const runs = db.prepare("SELECT * FROM runs").all();
  const steps = db.prepare("SELECT * FROM run_steps").all();
  const outbox = db.prepare("SELECT * FROM sync_outbox ORDER BY seq").all();
  const triggers = db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%runs%' ORDER BY name",
    )
    .all();
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  db.exec(sql("0064_research_routing.sql"));
  db.exec("COMMIT; PRAGMA foreign_keys=ON");
  expect(db.prepare("SELECT * FROM runs").all()).toEqual(
    runs.map((row) => ({ ...row, routing_stage: "work" })),
  );
  expect(db.prepare("SELECT * FROM run_steps").all()).toEqual(steps);
  expect(db.prepare("SELECT * FROM sync_outbox ORDER BY seq").all()).toEqual(outbox);
  expect(
    db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%runs%' ORDER BY name",
      )
      .all(),
  ).toEqual(triggers);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  db.prepare(
    "INSERT INTO runs(id,workspace_id,user_id,task,kind,mode,provider,model,status,cap_micro_usd,created_at,updated_at) VALUES('research',?,?,'Read','research','plan','anthropic','fixture','running',5000000,1,2)",
  ).run(ws, user);
  expect(db.prepare("SELECT * FROM sync_outbox WHERE record_key='research'").all()).toEqual([]);
  db.exec("UPDATE runs SET routing_stage='complete',status='done' WHERE id='research'");
  const published = db
    .prepare("SELECT payload FROM sync_outbox WHERE table_name='runs' AND record_key='research'")
    .get();
  expect(JSON.parse(published?.payload as string)).toMatchObject({
    kind: "research",
    status: "done",
  });
  expect(JSON.parse(published?.payload as string)).not.toHaveProperty("routing_stage");
  db.exec("DELETE FROM run_steps WHERE run_id='r'; DELETE FROM runs WHERE id='r'");
  expect(
    db
      .prepare(
        "SELECT operation FROM sync_outbox WHERE table_name='runs' AND record_key='r' ORDER BY seq DESC LIMIT 1",
      )
      .get(),
  ).toEqual({ operation: "delete" });
  db.close();
});
