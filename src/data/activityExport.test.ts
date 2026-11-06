// @vitest-environment node
import { DEFAULT_TENANT as t } from "@/storage/defaults";
import { openTestDb } from "@/storage/testing/nodeDb";
import { importUsageCsv, parseCsv } from "@/storage/usageReports";
import { activityCsv, activityJson, collectActivity, redactValue } from "./activityExport";

test("values that look like secrets are named, not shown; long ones are cut", () => {
  expect(redactValue("sk-proj-" + "a".repeat(40))).toMatch(/^\[removed: looked like/);
  expect(redactValue("password: hunter2hunter2")).toMatch(/^\[removed/);
  expect(redactValue("x".repeat(500))).toMatch(/… \(500 chars\)$/);
  expect(redactValue({ path: "notes.txt" })).toBe('{"path":"notes.txt"}');
});

test("tool calls, credential use, policy changes, context receipts and report runs export together", async () => {
  const db = openTestDb();
  const ws = t.workspaceId;
  const user = t.userId;
  await db.execute(
    "INSERT INTO runs(id,workspace_id,user_id,task,kind,mode,provider,model,status,cap_micro_usd,created_at,updated_at) VALUES('r',?,?,'Fix it','code','ask','openai','gpt-x','done',1000,1,1)",
    [ws, user],
  );
  await db.execute(
    "INSERT INTO run_steps(id,workspace_id,user_id,run_id,seq,kind,tool_name,input,output,is_error,approval,created_at,updated_at) VALUES('s',?,?,'r',1,'tool','write_file',?,?,0,'you',10,10)",
    [
      ws,
      user,
      JSON.stringify({ path: "app.ts", content: "const key = 'sk-proj-" + "b".repeat(40) + "'" }),
      "Wrote app.ts\nmore",
    ],
  );
  await db.execute(
    "INSERT INTO security_audit(id,workspace_id,user_id,event_kind,provider,scope_kind,action,created_at,updated_at) VALUES('a1',?,?,'credential_use','openai','global','request',20,20),('a2',?,?,'policy_change',NULL,'project','set',30,30)",
    [ws, user, ws, user],
  );
  await importUsageCsv(
    db,
    t,
    "source,date_utc,provider,kind,scope,key_id,model,line_item,currency,amount,input_tokens,output_tokens,cached_tokens,requests\ncsv,2026-11-05,openai,cost,,,,,usd,1,,,,",
  );
  const entries = await collectActivity(db, t);
  expect(entries.map((e) => e.category).sort()).toEqual(
    ["credential", "policy", "tool", "usage_report"].sort(),
  );
  const tool = entries.find((e) => e.category === "tool");
  expect(tool?.detail).toContain("path=app.ts");
  expect(tool?.detail).toContain("[removed: looked like");
  expect(tool?.detail).toContain("→ Wrote app.ts");
  const csv = activityCsv(entries);
  expect(csv).not.toMatch(/sk-proj-b/);
  expect(parseCsv(csv)[0]).toEqual([
    "when_utc",
    "category",
    "subject",
    "action",
    "where",
    "detail",
  ]);
  const json = JSON.parse(activityJson(entries)) as { redacted: boolean; entries: unknown[] };
  expect(json.redacted).toBe(true);
  expect(json.entries).toHaveLength(entries.length);
  expect(activityJson(entries)).not.toMatch(/sk-proj-b/);
});
