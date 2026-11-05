// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { migrationFiles } from "@/storage/testing/nodeDb";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";

test("schema 63 preserves populated cost history, circular references and pending sync events", () => {
  const db = new DatabaseSync(":memory:");
  const migration = (file: string) =>
    readFileSync(new URL(`../../src-tauri/migrations/${file}`, import.meta.url), "utf8");
  for (const file of migrationFiles().filter((f) => f < "0063")) db.exec(migration(file));
  const { workspaceId: ws, userId: user } = tenant;
  db.exec("UPDATE sync_state SET enabled=1");
  db.prepare(
    "INSERT INTO projects(id,workspace_id,user_id,name,created_at,updated_at) VALUES('p',?,?,'Fixture',1,1)",
  ).run(ws, user);
  db.prepare(
    "INSERT INTO threads(id,workspace_id,user_id,title,project_id,created_at,updated_at) VALUES('t',?,?,'Fixture','p',1,1)",
  ).run(ws, user);
  db.prepare(
    "INSERT INTO request_log(id,workspace_id,user_id,thread_id,message_id,purpose,provider,model,cost_micro_usd,created_at,updated_at) VALUES('legacy',?,?,'t','m','chat','openai','fixture',12345,5,6)",
  ).run(ws, user);
  db.prepare(
    "INSERT INTO messages(id,workspace_id,user_id,thread_id,role,content,request_id,created_at,updated_at) VALUES('m',?,?,'t','assistant','Fixture','legacy',5,6)",
  ).run(ws, user);
  db.prepare(
    "INSERT INTO request_reservations(id,workspace_id,user_id,provider,model,purpose,thread_id,message_id,project_id,bound_micro_usd,state,request_id,created_at,updated_at) VALUES('held',?,?,'openai','fixture','agent','t','m','p',15000,'unknown','legacy',5,6)",
  ).run(ws, user);
  const before = db.prepare("SELECT * FROM request_log").all();
  const pending = db.prepare("SELECT * FROM sync_outbox ORDER BY seq").all();
  const rules = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%request_log%' ORDER BY name",
    )
    .all();
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  db.exec(migration("0063_transcription.sql"));
  db.exec("COMMIT; PRAGMA foreign_keys=ON");
  expect(db.prepare("SELECT * FROM request_log").all()).toEqual(before);
  expect(db.prepare("SELECT * FROM sync_outbox ORDER BY seq").all()).toEqual(pending);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%request_log%' ORDER BY name",
      )
      .all(),
  ).toEqual(rules);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("SELECT request_id FROM messages WHERE id='m'").get()).toEqual({
    request_id: "legacy",
  });
  expect(
    db
      .prepare(
        "SELECT request_id,source_scope,audio_duration_ms FROM request_reservations WHERE id='held'",
      )
      .get(),
  ).toEqual({ request_id: "legacy", source_scope: null, audio_duration_ms: 0 });
  db.prepare(
    "INSERT INTO request_log(id,workspace_id,user_id,purpose,provider,model,created_at,updated_at) VALUES('speech',?,?,'transcribe','openai','gpt-transcribe',7,7)",
  ).run(ws, user);
  expect(
    db
      .prepare(
        "SELECT operation FROM sync_outbox WHERE table_name='request_log' AND record_key='speech'",
      )
      .get(),
  ).toEqual({ operation: "put" });
  db.close();
});
