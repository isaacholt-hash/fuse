// Scheduled tasks (M10 step 9, AG-07): a saved prompt the runner on HULK starts as a run, once
// at a time or every day or week at a time, in a new chat in its project. Times are the
// server's local time (migration 0051).
import type { RunKind, RunMode, RunStatus } from "./runs";
import type { SqlDb } from "./sql";
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";

export type Repeat = "once" | "daily" | "weekly";

export interface Schedule {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  kind: RunKind;
  mode: RunMode;
  provider: string;
  model: string;
  capMicroUsd: number;
  repeat: Repeat;
  /** 'once': when, in ms. */
  onceAt: number | null;
  /** 'daily' and 'weekly': minutes past local midnight. */
  minute: number;
  /** 'weekly': 0 is Sunday. */
  weekday: number | null;
  enabled: boolean;
  nextAt: number | null;
  lastRunId: string | null;
  lastThreadId: string | null;
  lastStatus: RunStatus | null;
  lastNote: string | null;
  lastAt: number | null;
}

export type ScheduleInput = Pick<
  Schedule,
  | "projectId"
  | "name"
  | "prompt"
  | "kind"
  | "mode"
  | "provider"
  | "model"
  | "capMicroUsd"
  | "repeat"
  | "onceAt"
  | "minute"
  | "weekday"
>;

/**
 * When it runs next after `now`, in local time: a one-off at its time if that's still ahead,
 * otherwise the next day (or the next of its weekday) at its minute. Null when there's none.
 */
export function nextRun(
  s: Pick<Schedule, "repeat" | "onceAt" | "minute" | "weekday">,
  now: number,
): number | null {
  if (s.repeat === "once") return s.onceAt !== null && s.onceAt > now ? s.onceAt : null;
  const at = new Date(now);
  at.setHours(Math.floor(s.minute / 60), s.minute % 60, 0, 0);
  if (s.repeat === "daily") {
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    // Days that are short or long (clock changes) still land on the minute asked for.
    at.setHours(Math.floor(s.minute / 60), s.minute % 60, 0, 0);
    return at.getTime();
  }
  const day = s.weekday ?? 0;
  let ahead = (day - at.getDay() + 7) % 7;
  if (ahead === 0 && at.getTime() <= now) ahead = 7;
  at.setDate(at.getDate() + ahead);
  at.setHours(Math.floor(s.minute / 60), s.minute % 60, 0, 0);
  return at.getTime();
}

/** Says when, for the list: "Daily at 07:30", "Mondays at 09:00", "Once, 3 Nov 14:00". */
export function describeRepeat(s: Pick<Schedule, "repeat" | "onceAt" | "minute" | "weekday">) {
  const hm = `${String(Math.floor(s.minute / 60)).padStart(2, "0")}:${String(s.minute % 60).padStart(2, "0")}`;
  if (s.repeat === "daily") return `Daily at ${hm}`;
  if (s.repeat === "weekly") {
    const days = [
      "Sundays",
      "Mondays",
      "Tuesdays",
      "Wednesdays",
      "Thursdays",
      "Fridays",
      "Saturdays",
    ];
    return `${days[s.weekday ?? 0] ?? "Sundays"} at ${hm}`;
  }
  if (s.onceAt === null) return "Once";
  const d = new Date(s.onceAt);
  return `Once, ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

interface Row {
  id: string;
  project_id: string;
  name: string;
  prompt: string;
  kind: RunKind;
  mode: RunMode;
  provider: string;
  model: string;
  cap_micro_usd: number;
  repeat: Repeat;
  once_at: number | null;
  minute: number;
  weekday: number | null;
  enabled: number;
  next_at: number | null;
  last_run_id: string | null;
  last_thread_id: string | null;
  last_status: RunStatus | null;
  last_note: string | null;
  last_at: number | null;
}

const COLUMNS = `id, project_id, name, prompt, kind, mode, provider, model, cap_micro_usd, repeat,
  once_at, minute, weekday, enabled, next_at, last_run_id, last_thread_id, last_status, last_note,
  last_at`;

const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  prompt: r.prompt,
  kind: r.kind,
  mode: r.mode,
  provider: r.provider,
  model: r.model,
  capMicroUsd: r.cap_micro_usd,
  repeat: r.repeat,
  onceAt: r.once_at,
  minute: r.minute,
  weekday: r.weekday,
  enabled: r.enabled === 1,
  nextAt: r.next_at,
  lastRunId: r.last_run_id,
  lastThreadId: r.last_thread_id,
  lastStatus: r.last_status,
  lastNote: r.last_note,
  lastAt: r.last_at,
});

function check(input: ScheduleInput): void {
  if (!input.name.trim()) throw new Error("Give the task a name.");
  if (!input.prompt.trim()) throw new Error("Say what the task should do.");
  if (input.minute < 0 || input.minute > 1439) throw new Error("Pick a time of day.");
  if (input.repeat === "once" && input.onceAt === null) throw new Error("Pick when it runs.");
  if (
    input.repeat === "weekly" &&
    (input.weekday === null || input.weekday < 0 || input.weekday > 6)
  )
    throw new Error("Pick a day of the week.");
}

export async function createSchedule(
  db: SqlDb,
  tenant: Tenant,
  input: ScheduleInput,
  now = Date.now(),
): Promise<Schedule> {
  check(input);
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO schedules (id, workspace_id, user_id, project_id, name, prompt, kind, mode,
       provider, model, cap_micro_usd, repeat, once_at, minute, weekday, enabled, next_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [
      id,
      tenant.workspaceId,
      tenant.userId,
      input.projectId,
      input.name.trim(),
      input.prompt,
      input.kind,
      input.mode,
      input.provider,
      input.model,
      input.capMicroUsd,
      input.repeat,
      input.onceAt,
      input.minute,
      input.repeat === "weekly" ? input.weekday : null,
      nextRun(input, now),
      now,
      now,
    ],
  );
  const made = await getSchedule(db, tenant, id);
  if (!made) throw new Error("Schedule insert failed");
  return made;
}

export async function updateSchedule(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  input: ScheduleInput,
  now = Date.now(),
): Promise<void> {
  check(input);
  const was = await getSchedule(db, tenant, id);
  await db.execute(
    `UPDATE schedules SET project_id = ?, name = ?, prompt = ?, kind = ?, mode = ?, provider = ?,
       model = ?, cap_micro_usd = ?, repeat = ?, once_at = ?, minute = ?, weekday = ?, next_at = ?,
       updated_at = ?
     WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`,
    [
      input.projectId,
      input.name.trim(),
      input.prompt,
      input.kind,
      input.mode,
      input.provider,
      input.model,
      input.capMicroUsd,
      input.repeat,
      input.onceAt,
      input.minute,
      input.repeat === "weekly" ? input.weekday : null,
      was?.enabled === false ? null : nextRun(input, now),
      now,
      tenant.workspaceId,
      id,
    ],
  );
}

/** Off: it won't run until switched on again, when its next time is worked out afresh. */
export async function setScheduleEnabled(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  enabled: boolean,
  now = Date.now(),
): Promise<void> {
  const s = await getSchedule(db, tenant, id);
  if (!s) return;
  await db.execute(
    "UPDATE schedules SET enabled = ?, next_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    [enabled ? 1 : 0, enabled ? nextRun(s, now) : null, now, tenant.workspaceId, id],
  );
}

export async function deleteSchedule(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  const now = Date.now();
  await db.execute(
    `UPDATE schedules SET deleted_at = ?, next_at = NULL, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [now, now, tenant.workspaceId, id],
  );
}

export async function getSchedule(db: SqlDb, tenant: Tenant, id: string): Promise<Schedule | null> {
  const rows = await db.select<Row>(
    `SELECT ${COLUMNS} FROM schedules WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`,
    [tenant.workspaceId, id],
  );
  return rows[0] ? toSchedule(rows[0]) : null;
}

/** A project's tasks, or every one; by name. */
export async function listSchedules(
  db: SqlDb,
  tenant: Tenant,
  projectId?: string,
): Promise<Schedule[]> {
  const rows = await db.select<Row>(
    `SELECT ${COLUMNS} FROM schedules
     WHERE workspace_id = ? AND deleted_at IS NULL ${projectId ? "AND project_id = ?" : ""}
     ORDER BY name COLLATE NOCASE, id`,
    projectId ? [tenant.workspaceId, projectId] : [tenant.workspaceId],
  );
  return rows.map(toSchedule);
}

/** Tasks whose time has come, soonest first. */
export async function dueSchedules(db: SqlDb, tenant: Tenant, now: number): Promise<Schedule[]> {
  const rows = await db.select<Row>(
    `SELECT ${COLUMNS} FROM schedules
     WHERE workspace_id = ? AND deleted_at IS NULL AND enabled = 1 AND next_at IS NOT NULL
       AND next_at <= ?
     ORDER BY next_at, id`,
    [tenant.workspaceId, now],
  );
  return rows.map(toSchedule);
}

/**
 * The runner started it: when it runs next (a missed time isn't made up: the next one after
 * now), and the chat its run is in. A one-off is done.
 */
export async function markStarted(
  db: SqlDb,
  tenant: Tenant,
  s: Schedule,
  threadId: string,
  now: number,
): Promise<void> {
  await db.execute(
    `UPDATE schedules SET next_at = ?, last_thread_id = ?, last_run_id = NULL, last_status = NULL,
       last_note = NULL, last_at = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [nextRun(s, now), threadId, now, now, tenant.workspaceId, s.id],
  );
}

/** The run it started, once the runner knows it. */
export async function setScheduleRun(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  runId: string,
): Promise<void> {
  await db.execute("UPDATE schedules SET last_run_id = ? WHERE workspace_id = ? AND id = ?", [
    runId,
    tenant.workspaceId,
    id,
  ]);
}

/** How its last run ended; a failure keeps the run's note and its last step. */
export async function setScheduleOutcome(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  status: RunStatus,
  note: string | null,
): Promise<void> {
  await db.execute(
    `UPDATE schedules SET last_status = ?, last_note = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [status, note, Date.now(), tenant.workspaceId, id],
  );
}
