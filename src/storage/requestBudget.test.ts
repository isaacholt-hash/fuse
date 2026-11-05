// @vitest-environment node
import { DEFAULT_TENANT as tenant } from "./defaults";
import { openTestDb } from "./testing/nodeDb";
import { createRun, getRun } from "./runs";
import { EMPTY_USAGE } from "./usage";
import { createProject, setProjectPrivacy } from "./projects";
import {
  dispatchRequest,
  interruptRequests,
  releaseRequest,
  reserveRequest,
  runExposure,
  settleRequest,
  type Reservation,
} from "./requestBudget";
import type { RequestLogEntry } from "./requestLog";
import { createThread, setThreadProject } from "./threads";
import { spentSince } from "./budgets";

async function setup() {
  const db = openTestDb();
  const run = await createRun(db, tenant, {
    projectId: null,
    threadId: null,
    messageId: null,
    task: "Fixture",
    provider: "openai",
    model: "fixture",
    capMicroUsd: 1000,
  });
  const hold = (id: string, boundMicroUsd = 700): Reservation => ({
    id,
    runId: run.id,
    provider: "openai",
    model: "fixture",
    purpose: "agent",
    threadId: null,
    messageId: null,
    boundMicroUsd,
  });
  return { db, run, hold };
}
const receipt = (
  billingState: RequestLogEntry["billingState"] = "reported",
  amount = 100,
): RequestLogEntry => ({
  threadId: null,
  messageId: null,
  purpose: "agent",
  provider: "openai",
  model: "fixture",
  attempt: 1,
  usage: {
    ...EMPTY_USAGE,
    costMicroUsd: amount,
    priceVersion: billingState === "reported" ? "fixture" : null,
  },
  billingState,
  httpStatus: 200,
  errorCode: null,
  errorMessage: null,
  providerRequestId: "fixture-response",
});

test("concurrent holds cannot oversubscribe a cap; dispatch and settlement are idempotent", async () => {
  const { db, run, hold } = await setup();
  expect(
    await Promise.all([
      reserveRequest(db, tenant, hold("first")),
      reserveRequest(db, tenant, hold("second")),
    ]),
  ).toEqual([true, false]);
  expect(await dispatchRequest(db, tenant, "first")).toBe(true);
  expect(await dispatchRequest(db, tenant, "first")).toBe(false);
  await settleRequest(db, tenant, "first", receipt());
  await settleRequest(db, tenant, "first", receipt());
  expect(await runExposure(db, tenant, run.id)).toEqual({ spent: 100, held: 0, cap: 1000 });
  expect(await db.select("SELECT id FROM request_log")).toHaveLength(1);
  expect(await reserveRequest(db, tenant, hold("too-much", 901))).toBe(false);
  expect(await reserveRequest(db, tenant, hold("fits", 900))).toBe(true);
  await db.execute("UPDATE runs SET status='paused' WHERE id=?", [run.id]);
  expect(await dispatchRequest(db, tenant, "fits")).toBe(false);
  await db.execute("UPDATE runs SET status='running',sync_owner='another-device' WHERE id=?", [
    run.id,
  ]);
  expect(await dispatchRequest(db, tenant, "fits")).toBe(false);
  expect((await runExposure(db, tenant, run.id)).held).toBe(900);
});

test("unknown billing retains exposure, even after cancel; only undispatched work releases", async () => {
  const { db, run, hold } = await setup();
  await reserveRequest(db, tenant, hold("lost"));
  await dispatchRequest(db, tenant, "lost");
  await settleRequest(db, tenant, "lost", receipt("unknown", 0));
  await releaseRequest(db, tenant, "lost");
  expect(await runExposure(db, tenant, run.id)).toEqual({ spent: 0, held: 700, cap: 1000 });
  expect(await reserveRequest(db, tenant, hold("too-much", 301))).toBe(false);
  expect(await reserveRequest(db, tenant, hold("fits", 300))).toBe(true);
  await releaseRequest(db, tenant, "fits");
  expect((await runExposure(db, tenant, run.id)).held).toBe(700);
});

test("failed settlement rolls back receipt, spend and hold together", async () => {
  const { db, run, hold } = await setup();
  await reserveRequest(db, tenant, hold("atomic"));
  await dispatchRequest(db, tenant, "atomic");
  await expect(
    settleRequest(db, tenant, "atomic", { ...receipt(), projectId: "missing-project" }),
  ).rejects.toThrow();
  expect(await db.select("SELECT id FROM request_log")).toHaveLength(0);
  expect((await getRun(db, tenant, run.id))?.spentMicroUsd).toBe(0);
  expect((await runExposure(db, tenant, run.id)).held).toBe(700);
  await settleRequest(db, tenant, "atomic", receipt());
  expect((await getRun(db, tenant, run.id))?.spentMicroUsd).toBe(100);
});

test("startup recovery releases unsent holds and records dispatched work as unknown without replay", async () => {
  const { db, run, hold } = await setup();
  await reserveRequest(db, tenant, hold("sent", 600));
  await reserveRequest(db, tenant, hold("unsent", 400));
  await dispatchRequest(db, tenant, "sent");
  await interruptRequests(db, tenant);
  await interruptRequests(db, tenant);
  expect(await runExposure(db, tenant, run.id)).toEqual({ spent: 0, held: 600, cap: 1000 });
  expect(await dispatchRequest(db, tenant, "sent")).toBe(false);
  expect(await dispatchRequest(db, tenant, "unsent")).toBe(false);
  expect(await db.select("SELECT billing_state,attempt_id FROM request_log")).toEqual([
    { billing_state: "unknown", attempt_id: "sent" },
  ]);
});

test("runner recovery leaves in-flight native transcription with its existing execution owner", async () => {
  const { db, hold } = await setup();
  await reserveRequest(db, tenant, { ...hold("native", 75), runId: null, purpose: "transcribe" });
  await dispatchRequest(db, tenant, "native");
  await interruptRequests(db, tenant);
  expect(await db.select("SELECT state FROM request_reservations WHERE id='native'")).toEqual([
    { state: "dispatched" },
  ]);
  expect(await db.select("SELECT id FROM request_log")).toEqual([]);
});

test("project-only audio cost metadata withdraws when privacy tightens; audit is content-free", async () => {
  const { db, hold } = await setup();
  await db.execute("UPDATE sync_state SET enabled=1");
  const project = await createProject(db, tenant, "Private draft name");
  await reserveRequest(db, tenant, { ...hold("audio"), projectId: project.id });
  await dispatchRequest(db, tenant, "audio");
  await settleRequest(db, tenant, "audio", {
    ...receipt(),
    projectId: project.id,
    audioDurationMs: 60000,
  });
  expect(await spentSince(db, tenant, 0, project.id)).toBe(100);
  const before = await db.select<{ payload: string }>(
    "SELECT payload FROM sync_outbox WHERE table_name='request_log' ORDER BY seq",
  );
  expect(JSON.parse(before.at(-1)?.payload ?? "{}")).toMatchObject({
    audio_duration_ms: 60000,
    billing_state: "reported",
    project_id: project.id,
  });
  await setProjectPrivacy(db, tenant, project.id, { mode: "local_only", allowEmbeddings: false });
  const events = await db.select(
    "SELECT operation,payload FROM sync_outbox WHERE table_name='request_log' ORDER BY seq",
  );
  expect(events.at(-1)).toEqual({ operation: "withdraw", payload: null });
  expect(JSON.stringify(await db.select("SELECT * FROM security_audit"))).not.toContain(
    "Private draft name",
  );
  expect(await db.select("SELECT * FROM security_audit")).toHaveLength(1);
});

test("policy audit rolls back with its originating write", async () => {
  const { db } = await setup();
  const project = await createProject(db, tenant, "Fixture");
  await expect(
    db.batch([
      { sql: "UPDATE projects SET privacy_mode='local_only' WHERE id=?", params: [project.id] },
      { sql: "INSERT INTO missing_table VALUES(1)" },
    ]),
  ).rejects.toThrow();
  expect(await db.select("SELECT * FROM security_audit")).toEqual([]);
});

test("cost attribution still follows a moved chat, with direct project scope only as fallback", async () => {
  const { db, hold } = await setup();
  const original = await createProject(db, tenant, "Original");
  const moved = await createProject(db, tenant, "Moved");
  const thread = await createThread(db, tenant, "Chat", original.id);
  await reserveRequest(db, tenant, {
    ...hold("move"),
    threadId: thread.id,
    projectId: original.id,
  });
  await dispatchRequest(db, tenant, "move");
  await settleRequest(db, tenant, "move", {
    ...receipt(),
    threadId: thread.id,
    projectId: original.id,
  });
  await setThreadProject(db, tenant, thread.id, moved.id);
  expect(await spentSince(db, tenant, 0, original.id)).toBe(0);
  expect(await spentSince(db, tenant, 0, moved.id)).toBe(100);
  await setThreadProject(db, tenant, thread.id, null);
  expect(await spentSince(db, tenant, 0, original.id)).toBe(0);
  expect(await spentSince(db, tenant, 0, moved.id)).toBe(0);
});
