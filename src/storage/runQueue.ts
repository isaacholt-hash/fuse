// Runs on HULK (M10 step 6, CA-15): what a page asks the server's runner to do, the questions a
// run there waits on, and the text it's streaming. The page and the runner share the server's
// database, so this is how they talk (migration 0050).
import type { RunKind, RunMode } from "./runs";
import type { SqlDb } from "./sql";
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";

/** A model by provider and id, as it's stored (the runner looks it up in its catalog). */
export interface ModelRef {
  provider: string;
  id: string;
}

/** A chat run to start, as the page asks for it (`ChatRunInput` without the callbacks). */
export interface StartInput {
  /** Null for a handover: the runner makes the chat. */
  threadId: string | null;
  projectId: string | null;
  task: string;
  model: ModelRef;
  mode?: RunMode;
  kind?: RunKind;
  newBranch?: boolean;
  planner?: ModelRef | null;
  capMicroUsd?: number;
  /** M10 step 7: a run handed over from a desktop. */
  handover?: Handover;
}

/**
 * A desktop's handover: its project's export (uploaded to the server's files), and where the
 * runner gets the repository. The run works on a `fuse/…` branch and asks before pushing it.
 */
export interface Handover {
  exportSha: string;
  remote: string;
  branch: string;
}

type Ask =
  | { kind: "start"; input: StartInput }
  | { kind: "continue"; input: { runId: string; raiseCapBy?: number } }
  | { kind: "stop"; input: { runId: string } };

export type RunRequest = Ask & { id: string };

interface RequestRow {
  id: string;
  kind: RunRequest["kind"];
  input: string;
}

async function enqueue(db: SqlDb, tenant: Tenant, ask: Ask): Promise<string> {
  const now = Date.now();
  const id = uuidv7(now);
  const runId = "runId" in ask.input ? ask.input.runId : null;
  await db.execute(
    `INSERT INTO run_requests (id, workspace_id, user_id, kind, input, run_id, created_at,
       updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, tenant.workspaceId, tenant.userId, ask.kind, JSON.stringify(ask.input), runId, now, now],
  );
  return id;
}

export const askToStart = (db: SqlDb, tenant: Tenant, input: StartInput) =>
  enqueue(db, tenant, { kind: "start", input });

export const askToContinue = (db: SqlDb, tenant: Tenant, runId: string, raiseCapBy?: number) =>
  enqueue(db, tenant, {
    kind: "continue",
    input: raiseCapBy ? { runId, raiseCapBy } : { runId },
  });

export const askToStop = (db: SqlDb, tenant: Tenant, runId: string) =>
  enqueue(db, tenant, { kind: "stop", input: { runId } });

/** The runner's next request, oldest first, marked taken so it's done once. */
export async function takeRequest(db: SqlDb, tenant: Tenant): Promise<RunRequest | null> {
  const rows = await db.select<RequestRow>(
    `SELECT id, kind, input FROM run_requests
     WHERE workspace_id = ? AND status = 'queued' ORDER BY created_at, id LIMIT 1`,
    [tenant.workspaceId],
  );
  const row = rows[0];
  if (!row) return null;
  const taken = await db.execute(
    `UPDATE run_requests SET status = 'taken', updated_at = ?
     WHERE workspace_id = ? AND id = ? AND status = 'queued'`,
    [Date.now(), tenant.workspaceId, row.id],
  );
  if (taken.rowsAffected === 0) return null;
  const input: unknown = JSON.parse(row.input);
  return { id: row.id, kind: row.kind, input } as RunRequest;
}

/** Records how a request went, and which run it started. */
export async function finishRequest(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  outcome: { runId?: string; error?: string },
): Promise<void> {
  await db.execute(
    `UPDATE run_requests SET status = ?, run_id = COALESCE(?, run_id), error = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [
      outcome.error ? "failed" : "done",
      outcome.runId ?? null,
      outcome.error ?? null,
      Date.now(),
      tenant.workspaceId,
      id,
    ],
  );
}

/** Requests a runner had taken when it stopped: they can't be finished now. */
export async function failTakenRequests(db: SqlDb, tenant: Tenant): Promise<number> {
  const r = await db.execute(
    `UPDATE run_requests SET status = 'failed', error = 'The server restarted.', updated_at = ?
     WHERE workspace_id = ? AND status = 'taken'`,
    [Date.now(), tenant.workspaceId],
  );
  return r.rowsAffected;
}

/** A start request the page made, with what became of it (the page waits for its run). */
export async function getRequest(
  db: SqlDb,
  tenant: Tenant,
  id: string,
): Promise<{
  status: "queued" | "taken" | "done" | "failed";
  runId: string | null;
  error: string | null;
} | null> {
  const rows = await db.select<{
    status: "queued" | "taken" | "done" | "failed";
    run_id: string | null;
    error: string | null;
  }>("SELECT status, run_id, error FROM run_requests WHERE workspace_id = ? AND id = ?", [
    tenant.workspaceId,
    id,
  ]);
  const r = rows[0];
  return r ? { status: r.status, runId: r.run_id, error: r.error } : null;
}

export interface OpenApproval<Request = unknown> {
  id: string;
  runId: string;
  request: Request;
  createdAt: number;
}

/** A run on the server asks; returns the question's id. */
export async function addApproval(
  db: SqlDb,
  tenant: Tenant,
  runId: string,
  request: unknown,
): Promise<string> {
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO run_approvals (id, workspace_id, user_id, run_id, request, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, tenant.workspaceId, tenant.userId, runId, JSON.stringify(request), now],
  );
  return id;
}

/** Questions no one has answered yet, oldest first. */
export async function openApprovals<Request = unknown>(
  db: SqlDb,
  tenant: Tenant,
): Promise<OpenApproval<Request>[]> {
  const rows = await db.select<{ id: string; run_id: string; request: string; created_at: number }>(
    `SELECT id, run_id, request, created_at FROM run_approvals
     WHERE workspace_id = ? AND answered_at IS NULL ORDER BY created_at, id`,
    [tenant.workspaceId],
  );
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    request: JSON.parse(r.request) as Request,
    createdAt: r.created_at,
  }));
}

/** Answers a question once; false if it was already answered (by another page, or Stop). */
export async function answerApproval(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  answer: unknown,
): Promise<boolean> {
  const r = await db.execute(
    `UPDATE run_approvals SET answer = ?, answered_at = ?
     WHERE workspace_id = ? AND id = ? AND answered_at IS NULL`,
    [JSON.stringify(answer), Date.now(), tenant.workspaceId, id],
  );
  return r.rowsAffected > 0;
}

/** The answer, once there is one. */
export async function approvalAnswer(
  db: SqlDb,
  tenant: Tenant,
  id: string,
): Promise<{ answer: unknown } | null> {
  const rows = await db.select<{ answer: string | null }>(
    "SELECT answer FROM run_approvals WHERE workspace_id = ? AND id = ?",
    [tenant.workspaceId, id],
  );
  const a = rows[0]?.answer;
  return a == null ? null : { answer: JSON.parse(a) };
}

/** Questions left open when the runner stopped count as no. */
export async function closeOpenApprovals(db: SqlDb, tenant: Tenant): Promise<number> {
  const r = await db.execute(
    `UPDATE run_approvals SET answer = '"no"', answered_at = ?
     WHERE workspace_id = ? AND answered_at IS NULL`,
    [Date.now(), tenant.workspaceId],
  );
  return r.rowsAffected;
}

export async function setLive(db: SqlDb, tenant: Tenant, runId: string, streaming: string) {
  await db.execute(
    `INSERT INTO run_live (run_id, workspace_id, user_id, streaming, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id) DO UPDATE SET streaming = excluded.streaming,
       updated_at = excluded.updated_at`,
    [runId, tenant.workspaceId, tenant.userId, streaming, Date.now(), Date.now()],
  );
}

export async function getLive(db: SqlDb, tenant: Tenant, runId: string): Promise<string> {
  const rows = await db.select<{ streaming: string }>(
    "SELECT streaming FROM run_live WHERE workspace_id = ? AND run_id = ?",
    [tenant.workspaceId, runId],
  );
  return rows[0]?.streaming ?? "";
}
