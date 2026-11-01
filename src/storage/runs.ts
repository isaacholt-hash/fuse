// Coding runs and their steps (M6 step 5, CA-07). See docs/data-model.md and 0030_runs.sql.
import type { NativeTurn, ToolCall } from "@/providers/types";
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export type RunStatus = "running" | "paused" | "done" | "stopped" | "error";
/** CA-04: read-only, ask before each edit and command (step 8), or edits go ahead. */
export type RunMode = "plan" | "ask" | "auto_edit";

/** M6 coding, or M8 work on documents (WF-01). */
export type RunKind = "code" | "work";

export interface Run {
  id: string;
  /** Null for a run in a chat outside a project (M8, WF-02). */
  projectId: string | null;
  kind: RunKind;
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
  /** CA-08: what earlier steps did, once the run outgrew its budget; steps up to `summaryUpto`
   * aren't sent again. */
  summary: string | null;
  summaryUpto: number | null;
  /** CA-05: the branch it made for itself, if it did. */
  branch: string | null;
  /** RT-14: the plan a Best model wrote before the loop, and which model ("provider/id"). */
  plan: string | null;
  planner: string | null;
  createdAt: number;
  updatedAt: number;
  /** M10 step 11: when its current leg started (Continue starts a new one). */
  startedAt: number;
  /** M10 step 11: time in that leg spent waiting for your answer; counts toward no limit. */
  waitedMs: number;
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
      /** How it was allowed (AG-04 audit): needed nobody, you, always-allowed, or declined. */
      approval: Approval | null;
      /** WF-03: images it showed the model, by attachment-store hash. */
      images: StepImage[];
      /** M9 step 4: what its output seemed to ask for; none when it read as plain data. */
      flags?: StepFlag[];
    };

export type Approval = "auto" | "you" | "always" | "denied";

/** M9 step 4 (AG-10): a passage in a tool's output that reads like an instruction, and why. */
export interface StepFlag {
  /** "says to ignore your instructions", "asks to run a command", … */
  why: string;
  passage: string;
}

/** An image a tool step showed the model; its bytes are in the attachment store. */
export interface StepImage {
  sha256: string;
  mime: string;
}

interface RunRow {
  id: string;
  project_id: string | null;
  kind: RunKind;
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
  summary: string | null;
  summary_upto: number | null;
  branch: string | null;
  plan: string | null;
  planner: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  waited_ms: number;
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
  approval: Approval | null;
  images: string | null;
  flags: string | null;
  cost_micro_usd: number;
}

const toRun = (r: RunRow): Run => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind,
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
  summary: r.summary,
  summaryUpto: r.summary_upto,
  branch: r.branch,
  plan: r.plan,
  planner: r.planner,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  startedAt: r.started_at ?? r.created_at,
  waitedMs: r.waited_ms,
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
        approval: r.approval,
        images: r.images ? (JSON.parse(r.images) as StepImage[]) : [],
        ...(r.flags ? { flags: JSON.parse(r.flags) as StepFlag[] } : {}),
      };

export async function createRun(
  db: SqlDb,
  tenant: Tenant,
  run: Pick<
    Run,
    "projectId" | "threadId" | "messageId" | "task" | "provider" | "model" | "capMicroUsd"
  > & { mode?: RunMode; kind?: RunKind },
): Promise<Run> {
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO runs (id, workspace_id, user_id, project_id, thread_id, message_id, task, kind,
       mode, provider, model, status, cap_micro_usd, created_at, updated_at, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    [
      id,
      tenant.workspaceId,
      tenant.userId,
      run.projectId,
      run.threadId,
      run.messageId,
      run.task,
      run.kind ?? "code",
      run.mode ?? "plan",
      run.provider,
      run.model,
      run.capMicroUsd,
      now,
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
    `SELECT id, project_id, kind, thread_id, message_id, task, mode, provider, model, status,
       cap_micro_usd, spent_micro_usd, note, summary, summary_upto, branch, plan, planner, created_at,
       updated_at, started_at, waited_ms
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

export async function setRunPlan(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  plan: string,
  planner: string,
): Promise<void> {
  await db.execute(
    "UPDATE runs SET plan = ?, planner = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    [plan, planner, Date.now(), tenant.workspaceId, id],
  );
}

export async function setRunBranch(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  branch: string,
): Promise<void> {
  await db.execute("UPDATE runs SET branch = ?, updated_at = ? WHERE workspace_id = ? AND id = ?", [
    branch,
    Date.now(),
    tenant.workspaceId,
    id,
  ]);
}

/** A cost outside the run's turns (its summaries), added to what it has spent. */
export async function addRunCost(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  micro: number,
): Promise<void> {
  await db.execute(
    `UPDATE runs SET spent_micro_usd = spent_micro_usd + ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [micro, Date.now(), tenant.workspaceId, id],
  );
}

/** CA-08: earlier steps, summarized; the loop goes on from here. */
export async function setRunSummary(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  summary: string,
  upto: number,
): Promise<void> {
  await db.execute(
    `UPDATE runs SET summary = ?, summary_upto = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [summary, upto, Date.now(), tenant.workspaceId, id],
  );
}

/** Runs left working when the app closed are stopped, so they can be continued. */
export async function markInterruptedRuns(db: SqlDb, tenant: Tenant): Promise<number> {
  const result = await db.execute(
    `UPDATE runs SET status = 'stopped', note = 'FUSE closed while it was working.', updated_at = ?
     WHERE workspace_id = ? AND status = 'running'`,
    [Date.now(), tenant.workspaceId],
  );
  return result.rowsAffected;
}

/**
 * M10 step 11: Continue starts a new leg: the run is running again, its clock starts now, and the
 * time it waited before is forgotten (it belonged to the last leg).
 */
export async function markRunContinued(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  const now = Date.now();
  await db.execute(
    `UPDATE runs SET status = 'running', note = NULL, started_at = ?, waited_ms = 0, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [now, now, tenant.workspaceId, id],
  );
}

/** M10 step 11: a question was answered after `ms` of waiting; it counts toward no limit. */
export async function addRunWait(db: SqlDb, tenant: Tenant, id: string, ms: number): Promise<void> {
  if (ms <= 0) return;
  await db.execute(
    `UPDATE runs SET waited_ms = waited_ms + ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [Math.floor(ms), Date.now(), tenant.workspaceId, id],
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
       is_error, approval, images, flags, cost_micro_usd
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
  step: {
    call: ToolCall;
    output: string;
    isError: boolean;
    approval?: Approval;
    images?: StepImage[];
    flags?: StepFlag[];
  },
): Promise<string> {
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO run_steps (id, workspace_id, user_id, run_id, seq, kind, tool_name, tool_call_id,
       input, output, is_error, approval, images, flags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'tool', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenant.workspaceId,
      tenant.userId,
      runId,
      await nextSeq(db, tenant, runId),
      step.call.name,
      step.call.id,
      JSON.stringify(step.call.input),
      step.output,
      step.isError ? 1 : 0,
      step.approval ?? null,
      step.images?.length ? JSON.stringify(step.images) : null,
      step.flags?.length ? JSON.stringify(step.flags) : null,
      now,
      now,
    ],
  );
  return id;
}

/** The runs shown in a chat's answers, with their steps, by answer id. */
export async function runsForThread(
  db: SqlDb,
  tenant: Tenant,
  threadId: string,
): Promise<Map<string, { run: Run; steps: RunStep[]; changes: RunChange[] }>> {
  const rows = await db.select<{ id: string }>(
    "SELECT id FROM runs WHERE workspace_id = ? AND thread_id = ? AND message_id IS NOT NULL",
    [tenant.workspaceId, threadId],
  );
  const out = new Map<string, { run: Run; steps: RunStep[]; changes: RunChange[] }>();
  for (const { id } of rows) {
    const run = await getRun(db, tenant, id);
    if (run?.messageId) {
      out.set(run.messageId, {
        run,
        steps: await listSteps(db, tenant, id),
        changes: await listChanges(db, tenant, id),
      });
    }
  }
  return out;
}

/** A file a run changed (CA-02). `before` null: it was created; `after` null: deleted. */
export interface RunChange {
  id: string;
  runId: string;
  stepId: string | null;
  path: string;
  fromPath: string | null;
  before: string | null;
  after: string | null;
  /** WF-04: for a binary file, the bytes it replaced and wrote, by attachment-store hash. */
  beforeSha: string | null;
  afterSha: string | null;
  /** WF-06: the organise plan it was part of; undoing one undoes them all. */
  batchId: string | null;
  status: "applied" | "undone";
  createdAt: number;
}

interface ChangeRow {
  id: string;
  run_id: string;
  step_id: string | null;
  path: string;
  from_path: string | null;
  before: string | null;
  after: string | null;
  before_sha: string | null;
  after_sha: string | null;
  batch_id: string | null;
  status: "applied" | "undone";
  created_at: number;
}

const toChange = (r: ChangeRow): RunChange => ({
  id: r.id,
  runId: r.run_id,
  stepId: r.step_id,
  path: r.path,
  fromPath: r.from_path,
  before: r.before,
  after: r.after,
  beforeSha: r.before_sha,
  afterSha: r.after_sha,
  batchId: r.batch_id,
  status: r.status,
  createdAt: r.created_at,
});

const CHANGE_COLUMNS =
  "id, run_id, step_id, path, from_path, before, after, before_sha, after_sha, batch_id, status, created_at";

export async function addChange(
  db: SqlDb,
  tenant: Tenant,
  c: Omit<RunChange, "id" | "status" | "createdAt" | "beforeSha" | "afterSha" | "batchId"> &
    Partial<Pick<RunChange, "beforeSha" | "afterSha" | "batchId">>,
): Promise<string> {
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO run_changes (id, workspace_id, user_id, run_id, step_id, path, from_path, before,
       after, before_sha, after_sha, batch_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenant.workspaceId,
      tenant.userId,
      c.runId,
      c.stepId,
      c.path,
      c.fromPath,
      c.before,
      c.after,
      c.beforeSha ?? null,
      c.afterSha ?? null,
      c.batchId ?? null,
      now,
      now,
    ],
  );
  return id;
}

export async function listChanges(db: SqlDb, tenant: Tenant, runId: string): Promise<RunChange[]> {
  const rows = await db.select<ChangeRow>(
    `SELECT ${CHANGE_COLUMNS} FROM run_changes WHERE workspace_id = ? AND run_id = ?
     ORDER BY created_at, id`,
    [tenant.workspaceId, runId],
  );
  return rows.map(toChange);
}

export async function getChange(db: SqlDb, tenant: Tenant, id: string): Promise<RunChange | null> {
  const rows = await db.select<ChangeRow>(
    `SELECT ${CHANGE_COLUMNS} FROM run_changes WHERE workspace_id = ? AND id = ?`,
    [tenant.workspaceId, id],
  );
  return rows[0] ? toChange(rows[0]) : null;
}

export async function markUndone(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  await db.execute(
    "UPDATE run_changes SET status = 'undone', updated_at = ? WHERE workspace_id = ? AND id = ?",
    [Date.now(), tenant.workspaceId, id],
  );
}

/** One tool call for the audit log (AG-04): what ran, how it was allowed, and its run. */
export interface AuditEntry {
  id: string;
  at: number;
  project: string;
  model: string;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
  approval: Approval | null;
  runCostMicroUsd: number;
  /** M9 step 4: what its output seemed to ask for. */
  flags: StepFlag[];
}

export async function recentToolCalls(
  db: SqlDb,
  tenant: Tenant,
  limit = 200,
): Promise<AuditEntry[]> {
  const rows = await db.select<{
    id: string;
    created_at: number;
    project: string;
    provider: string;
    model: string;
    tool_name: string;
    input: string | null;
    output: string | null;
    is_error: number;
    approval: Approval | null;
    flags: string | null;
    spent_micro_usd: number;
  }>(
    `SELECT s.id, s.created_at, COALESCE(p.name, 'No project') AS project, r.provider, r.model,
       s.tool_name, s.input, s.output, s.is_error, s.approval, s.flags, r.spent_micro_usd
     FROM run_steps s JOIN runs r ON r.id = s.run_id LEFT JOIN projects p ON p.id = r.project_id
     WHERE s.workspace_id = ? AND s.kind = 'tool'
     ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
    [tenant.workspaceId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    at: r.created_at,
    project: r.project,
    model: `${r.provider}/${r.model}`,
    tool: r.tool_name,
    input: r.input ? (JSON.parse(r.input) as Record<string, unknown>) : {},
    output: r.output ?? "",
    isError: r.is_error === 1,
    approval: r.approval,
    runCostMicroUsd: r.spent_micro_usd,
    flags: r.flags ? (JSON.parse(r.flags) as StepFlag[]) : [],
  }));
}

/** A folder a run works in, and what its paths call it (M8, WF-02). */
export interface RunFolder {
  folderId: string;
  label: string;
}

/** Records the folders a run works in, in order, so continuing or undoing it uses the same ones. */
export async function setRunFolders(
  db: SqlDb,
  tenant: Tenant,
  runId: string,
  folders: readonly RunFolder[],
): Promise<void> {
  const now = Date.now();
  for (const [i, f] of folders.entries()) {
    await db.execute(
      `INSERT INTO run_folders (id, workspace_id, user_id, run_id, folder_id, label, ordinal,
         created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv7(now), tenant.workspaceId, tenant.userId, runId, f.folderId, f.label, i, now],
    );
  }
}

export async function listRunFolders(
  db: SqlDb,
  tenant: Tenant,
  runId: string,
): Promise<RunFolder[]> {
  const rows = await db.select<{ folder_id: string; label: string }>(
    `SELECT folder_id, label FROM run_folders WHERE workspace_id = ? AND run_id = ?
     ORDER BY ordinal`,
    [tenant.workspaceId, runId],
  );
  return rows.map((r) => ({ folderId: r.folder_id, label: r.label }));
}

/** A run in the web app's Runs list (M10 step 6), with its chat's title. */
export interface RecentRun {
  id: string;
  threadId: string | null;
  /** Null when the run has no chat, or its chat was deleted. */
  threadTitle: string | null;
  task: string;
  status: RunStatus;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  /** M10 step 11: when its current leg started, and how long that leg waited for you. */
  startedAt: number;
  waitedMs: number;
  /** M10 step 14: what it has spent so far. */
  spentMicroUsd: number;
}

/** The latest runs across every chat, most recently changed first. */
export async function recentRuns(db: SqlDb, tenant: Tenant, limit = 50): Promise<RecentRun[]> {
  const rows = await db.select<{
    id: string;
    thread_id: string | null;
    title: string | null;
    task: string;
    status: RunStatus;
    note: string | null;
    created_at: number;
    updated_at: number;
    started_at: number | null;
    waited_ms: number;
    spent_micro_usd: number;
  }>(
    `SELECT r.id, r.thread_id, t.title, r.task, r.status, r.note, r.created_at, r.updated_at,
       r.started_at, r.waited_ms, r.spent_micro_usd
     FROM runs r
     LEFT JOIN threads t ON t.id = r.thread_id AND t.workspace_id = r.workspace_id
       AND t.deleted_at IS NULL
     WHERE r.workspace_id = ? ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`,
    [tenant.workspaceId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    threadId: r.thread_id,
    threadTitle: r.title,
    task: r.task,
    status: r.status,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at ?? r.created_at,
    waitedMs: r.waited_ms,
    spentMicroUsd: r.spent_micro_usd,
  }));
}

/** How many runs finished or failed after `since` (the Runs badge, M10 step 8). */
export async function runsEndedSince(db: SqlDb, tenant: Tenant, since: number): Promise<number> {
  const rows = await db.select<{ n: number }>(
    `SELECT COUNT(*) AS n FROM runs
     WHERE workspace_id = ? AND status IN ('done', 'error') AND updated_at > ?`,
    [tenant.workspaceId, since],
  );
  return rows[0]?.n ?? 0;
}

/**
 * A chat's runs, without their steps: what the web app checks every second to see which of them
 * it needs to load again (M10 step 6).
 */
export async function runStatesForThread(
  db: SqlDb,
  tenant: Tenant,
  threadId: string,
): Promise<{ id: string; messageId: string; status: RunStatus; updatedAt: number }[]> {
  const rows = await db.select<{
    id: string;
    message_id: string;
    status: RunStatus;
    updated_at: number;
  }>(
    `SELECT id, message_id, status, updated_at FROM runs
     WHERE workspace_id = ? AND thread_id = ? AND message_id IS NOT NULL`,
    [tenant.workspaceId, threadId],
  );
  return rows.map((r) => ({
    id: r.id,
    messageId: r.message_id,
    status: r.status,
    updatedAt: r.updated_at,
  }));
}

/** M10 step 13: a thread's latest run, as the sidebar shows it. */
export interface LatestRun {
  runId: string;
  status: RunStatus;
  updatedAt: number;
}

/** M10 step 13: every thread's latest run in one query, by thread id. */
export async function latestRunByThread(
  db: SqlDb,
  tenant: Tenant,
): Promise<Map<string, LatestRun>> {
  const rows = await db.select<{
    thread_id: string;
    id: string;
    status: RunStatus;
    updated_at: number;
  }>(
    `SELECT r.thread_id, r.id, r.status, r.updated_at FROM runs r
     WHERE r.workspace_id = ? AND r.thread_id IS NOT NULL
       AND r.id = (SELECT r2.id FROM runs r2 WHERE r2.thread_id = r.thread_id
                   ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1)`,
    [tenant.workspaceId],
  );
  return new Map(
    rows.map((r) => [r.thread_id, { runId: r.id, status: r.status, updatedAt: r.updated_at }]),
  );
}
