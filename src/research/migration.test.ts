// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { migrationFiles } from "@/storage/testing/nodeDb";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { DELETE_ORDER } from "@/data/deleteAll";
import { EXPORTED_TABLES } from "@/data/exportAll";
import registry from "../../data/sync.json";

test("schema 65 leaves populated application rows, triggers and sync events unchanged", () => {
  const db = new DatabaseSync(":memory:");
  const sql = (file: string) =>
    readFileSync(new URL(`../../src-tauri/migrations/${file}`, import.meta.url), "utf8");
  for (const file of migrationFiles().filter((file) => file < "0065")) db.exec(sql(file));
  db.exec("UPDATE sync_state SET enabled=1");
  db.prepare(
    "INSERT INTO runs(id,workspace_id,user_id,task,kind,mode,provider,model,status,cap_micro_usd,spent_micro_usd,created_at,updated_at) VALUES('existing',?,?,'Research fixture','research','plan','openai','fixture','paused',100000,123,1,2)",
  ).run(tenant.workspaceId, tenant.userId);
  const rows = db.prepare("SELECT * FROM runs").all();
  const outbox = db.prepare("SELECT * FROM sync_outbox ORDER BY seq").all();
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")
    .all();
  db.exec("BEGIN IMMEDIATE");
  db.exec(sql("0065_research_engine.sql"));
  db.exec("COMMIT");
  expect(db.prepare("SELECT * FROM runs").all()).toEqual(rows);
  expect(db.prepare("SELECT * FROM sync_outbox ORDER BY seq").all()).toEqual(outbox);
  expect(
    db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),
  ).toEqual(triggers);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM research_state").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM research_operations").all()).toEqual([]);
  for (const table of ["research_state", "research_operations"]) {
    expect(registry.localTables).toHaveProperty(table);
    expect(EXPORTED_TABLES).not.toContain(table);
    expect(DELETE_ORDER.indexOf(table as (typeof DELETE_ORDER)[number])).toBeLessThan(
      DELETE_ORDER.indexOf("runs"),
    );
  }
  db.close();
});
