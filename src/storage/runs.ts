// Coding runs and their steps (M6 step 5, CA-07). See docs/data-model.md and 0030_runs.sql.
import type { NativeTurn, ToolCall } from "@/providers/types";
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export type RunStatus = "running" | "paused" | "done" | "stopped" | "error";
export type RunMode = "plan";

export interface Run {
  id: string;
  projectId: string;
  threadId: string | null;
  messageId: string | null;
  task: string;
  mode: RunMode;
  provider: string;
  model: string;
  status: RunStatus;
  capMicroUsd: number;
  spentMicroUsd: number;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export type RunStep =
  | {
      kind: "model";
      id: string;
      seq: number;
      text: string;
      native: NativeTurn | null;
      requestId: string | null;
      costMicroUsd: number;
    }
  | {
      kind: "tool";
      id: string;
      seq: number;
      call: ToolCall;
      output: string;
      isError: boolean;
    };

interface RunRow {
  id: string;
  project_id: string;
  thread_id: string | null;
  message_id: string | null;
  task: string;
  mode: RunMode;
  provider: string;
  model: string;
  status: RunStatus;
  cap_micro_usd: number;
  spent_micro_usd: number;
  note: string | null;
  created_at: number;
  updated_at: number;
}

interface StepRow {
  id: string;
  seq: number;
  kind: "model" | "tool";
  text: string | null;
  native: string | null;
  request_id: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  input: string | null;
  output: string | null;
  is_error: number;
  cost_micro_usd: number;
}

const toRun = (r: RunRow): Run => ({
  id: r.id,
  projectId: r.project_id,
  threadId: r.thread_id,
  messageId: r.message_id,
  task: r.task,
  mode: r.mode,
  provider: r.provider,
  model: r.model,
  status: r.status,
  capMicroUsd: r.cap_micro_usd,
  spentMicroUsd: r.spent_micro_usd,
  note: r.note,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toStep = (r: StepRow): RunStep =>
  r.kind === "model"
    ? {
        kind: "model",
        id: r.id,
        seq: r.seq,
        text: r.text ?? "",
        native: r.native ? (JSON.parse(r.native) as NativeTurn) : null,
        requestId: r.request_id,
        costMicroUsd: r.cost_micro_usd,
      }
    : {
        kind: "tool",
        id: r.id,
        seq: r.seq,
        call: {
          id: r.tool_call_id ?? "",
          name: r.tool_name ?? "",
          input: r.input ? (JSON.parse(r.input) as Record<string, unknown>) : {},
        },
        output: r.output ?? "",
        isError: r.is_error === 1,
      };

export async function createRun(
  db: SqlDb,
  tenant: Tenant,
  run: Pick<
    Run,
    "projectId" | "threadId" | "messageId" | "task" | "provider" | "model" | "capMicroUsd"
  >,
): Promise<Run> {
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO runs (id, workspace_id, user_id, project_id, thread_id, message_id, task, mode,
       provider, model, status, cap_micro_usd, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'plan', ?, ?, 'running', ?, ?, ?)`,
    [
      id,
      tenant.workspaceId,
      tenant.userId,
      run.projectId,
      run.threadId,
      run.messageId,
      run.task,
      run.provider,
      run.model,
      run.capMicroUsd,
      now,
      now,
    ],
  );
  const created = await getRun(db, tenant, id);
  if (!created) throw new Error("Run insert failed");
  return created;
}

export async function getRun(db: SqlDb, tenant: Tenant, id: string): Promise<Run | null> {
  const rows = await db.select<RunRow>(
    `SELECT id, project_id, thread_id, message_id, task, mode, provider, model, status,
       cap_micro_usd, spent_micro_usd, note, created_at, updated_at
     FROM runs WHERE workspace_id = ? AND id = ?`,
    [tenant.workspaceId, id],
  );
  return rows[0] ? toRun(rows[0]) : null;
}

/** The run an answer shows, if it was a coding run. */
export async function runForMessage(
  db: SqlDb,
  tenant: Tenant,
  messageId: string,
): Promise<Run | null> {
  const rows = await db.select<{ id: string }>(
    "SELECT id FROM runs WHERE workspace_id = ? AND message_id = ?",
    [tenant.workspaceId, messageId],
  );
  return rows[0] ? getRun(db, tenant, rows[0].id) : null;
}

export async function setRunStatus(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  status: RunStatus,
  note: string | null = null,
): Promise<void> {
  await db.execute(
    "UPDATE runs SET status = ?, note = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    [status, note, Date.now(), tenant.workspaceId, id],
  );
}

/** Raises the cap (after a pause at the cap, with the user's say-so). */
export async function raiseRunCap(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  byMicroUsd: number,
): Promise<void> {
  await db.execute(
    `UPDATE runs SET cap_micro_usd = cap_micro_usd + ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [byMicroUsd, Date.now(), tenant.workspaceId, id],
  );
}

export async function listSteps(db: SqlDb, tenant: Tenant, runId: string): Promise<RunStep[]> {
  const rows = await db.select<StepRow>(
    `SELECT id, seq, kind, text, native, request_id, tool_name, tool_call_id, input, output,
       is_error, cost_micro_usd
     FROM run_steps WHERE workspace_id = ? AND run_id = ? ORDER BY seq`,
    [tenant.workspaceId, runId],
  );
  return rows.map(toStep);
}

async function nextSeq(db: SqlDb, tenant: Tenant, runId: string): Promise<number> {
  const rows = await db.select<{ n: number | null }>(
    "SELECT MAX(seq) AS n FROM run_steps WHERE workspace_id = ? AND run_id = ?",
    [tenant.workspaceId, runId],
  );
  return (rows[0]?.n ?? 0) + 1;
}

/** A model turn, and its cost added to the run's total. */
export async function addModelStep(
  db: SqlDb,
  tenant: Tenant,
  runId: string,
  step: { text: string; native: NativeTurn | null; requestId: string; costMicroUsd: number },
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO run_steps (id, workspace_id, user_id, run_id, seq, kind, text, native, request_id,
       cost_micro_usd, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'model', ?, ?, ?, ?, ?, ?)`,
    [
      uuidv7(now),
      tenant.workspaceId,
      tenant.userId,
      runId,
      await nextSeq(db, tenant, runId),
      step.text,
      step.native ? JSON.stringify(step.native) : null,
      step.requestId,
      step.costMicroUsd,
      now,
      now,
    ],
  );
  await db.execute(
    `UPDATE runs SET spent_micro_usd = spent_micro_usd + ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [step.costMicroUsd, now, tenant.workspaceId, runId],
  );
}

export async function addToolStep(
  db: SqlDb,
  tenant: Tenant,
  runId: string,
  step: { call: ToolCall; output: string; isError: boolean },
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO run_steps (id, workspace_id, user_id, run_id, seq, kind, tool_name, tool_call_id,
       input, output, is_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'tool', ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv7(now),
      tenant.workspaceId,
      tenant.userId,
      runId,
      await nextSeq(db, tenant, runId),
      step.call.name,
      step.call.id,
      JSON.stringify(step.call.input),
      step.output,
      step.isError ? 1 : 0,
      now,
      now,
    ],
  );
}
