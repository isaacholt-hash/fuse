/** Source and paid-attempt recovery stay on their execution owner. Report history is portable. */
import type { SqlDb, SqlStatement } from "@/storage/sql";
import type { Tenant } from "@/storage/defaults";
import { uuidv7 } from "@/storage/ids";
import type { ReviewState } from "./types";
import { object, validateSnapshot } from "./validate";
import { reviewMarkdown } from "./validate";
interface Db {
  db: SqlDb;
  tenant: Tenant;
}
export const owner = `EXISTS(SELECT 1 FROM review_state c JOIN runs r ON r.id=c.run_id AND r.workspace_id=c.workspace_id
 WHERE c.workspace_id=? AND c.user_id=? AND c.run_id=? AND c.lease=? AND r.review_profile=1 AND r.status='running'
 AND (r.sync_owner IS NULL OR r.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=r.workspace_id))
 AND (r.thread_id IS NULL OR EXISTS(SELECT 1 FROM threads t WHERE t.id=r.thread_id AND t.workspace_id=r.workspace_id AND t.deleted_at IS NULL))
 AND (r.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=r.project_id AND p.workspace_id=r.workspace_id AND p.deleted_at IS NULL)))`;
export const params = (deps: Db, runId: string, lease: string) => [
  deps.tenant.workspaceId,
  deps.tenant.userId,
  runId,
  lease,
];
export async function load(deps: Db, runId: string): Promise<ReviewState> {
  const row = (
    await deps.db.select<{ data: string }>(
      "SELECT data FROM review_state WHERE workspace_id=? AND user_id=? AND run_id=?",
      [deps.tenant.workspaceId, deps.tenant.userId, runId],
    )
  )[0];
  if (!row)
    throw new Error(
      "This review's source snapshot is unavailable on this installation. Start a fresh review on its execution owner.",
    );
  const v = object(JSON.parse(row.data) as unknown);
  if (
    v.version !== 1 ||
    !["plan", "analysis", "final", "finished"].includes(String(v.stage)) ||
    !v.source ||
    !v.worker ||
    !v.best
  )
    throw new Error("The review checkpoint is incompatible. Pending work is preserved.");
  validateSnapshot(v.snapshot);
  return v as unknown as ReviewState;
}
export async function initialize(deps: Db, runId: string, state: ReviewState): Promise<void> {
  const now = Date.now();
  const writes = await deps.db.batch([
    {
      sql: "UPDATE runs SET review_profile=1,mode='plan',routing_stage='plan',updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND status='running'",
      params: [now, deps.tenant.workspaceId, deps.tenant.userId, runId],
    },
    {
      sql: "INSERT INTO review_state(run_id,workspace_id,user_id,data,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND review_profile=1 AND status='running')",
      params: [
        runId,
        deps.tenant.workspaceId,
        deps.tenant.userId,
        JSON.stringify(state),
        now,
        now,
        runId,
      ],
    },
    {
      sql: "INSERT INTO run_steps(id,workspace_id,user_id,run_id,seq,kind,tool_name,tool_call_id,input,output,is_error,created_at,updated_at) SELECT ?,?,?,?,1,'tool','review_snapshot',?,?,?,0,?,? WHERE EXISTS(SELECT 1 FROM review_state WHERE run_id=?)",
      params: [
        uuidv7(now),
        deps.tenant.workspaceId,
        deps.tenant.userId,
        runId,
        uuidv7(now),
        JSON.stringify({ kind: state.source.kind }),
        JSON.stringify({
          snapshotId: state.snapshot.id,
          baseCommit: state.snapshot.baseCommit,
          headCommit: state.snapshot.headCommit,
          files: state.snapshot.files.map((f) => f.path),
          limitations: state.snapshot.limitations,
        }),
        now,
        now,
        runId,
      ],
    },
    ...(state.stage === "finished" && state.report
      ? [
          {
            sql: "INSERT INTO run_steps(id,workspace_id,user_id,run_id,seq,kind,tool_name,tool_call_id,input,output,is_error,created_at,updated_at) SELECT ?,?,?,?,2,'tool','review_result',?,'{}',?,0,?,? WHERE EXISTS(SELECT 1 FROM review_state WHERE run_id=?)",
            params: [
              uuidv7(now),
              deps.tenant.workspaceId,
              deps.tenant.userId,
              runId,
              uuidv7(now),
              reviewMarkdown(state.snapshot, state.report),
              now,
              now,
              runId,
            ],
          },
        ]
      : []),
  ]);
  if (writes.some((r) => r.rowsAffected !== 1))
    throw new Error("The review could not be initialized.");
}
export async function claim(deps: Db, runId: string): Promise<string> {
  const lease = uuidv7(),
    now = Date.now(),
    { workspaceId: ws, userId: user } = deps.tenant;
  const result = await deps.db.batch([
    {
      sql: `UPDATE review_state SET lease=?,updated_at=? WHERE workspace_id=? AND user_id=? AND run_id=?
    AND EXISTS(SELECT 1 FROM runs r WHERE r.id=review_state.run_id AND r.review_profile=1
    AND r.status!='done' AND (review_state.lease IS NULL OR r.status!='running')
    AND (r.sync_owner IS NULL OR r.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=r.workspace_id)))`,
      params: [lease, now, ws, user, runId],
    },
    {
      sql: "UPDATE runs SET status='running',note=NULL,started_at=?,waited_ms=0,updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND EXISTS(SELECT 1 FROM review_state WHERE run_id=? AND lease=?)",
      params: [now, now, ws, user, runId, runId, lease],
    },
  ]);
  if (result[0]?.rowsAffected !== 1)
    throw new Error("This review is already running, finished or belongs to another installation.");
  return lease;
}
export async function pending(deps: Db, runId: string): Promise<{ id: string; state: string }[]> {
  return deps.db.select(
    "SELECT id,state FROM review_operations WHERE workspace_id=? AND user_id=? AND run_id=? AND state IN ('pending','unknown') ORDER BY created_at,id",
    [deps.tenant.workspaceId, deps.tenant.userId, runId],
  );
}
export async function begin(
  deps: Db,
  runId: string,
  lease: string,
  stage: string,
): Promise<string> {
  const id = uuidv7(),
    now = Date.now();
  const result = await deps.db.execute(
    `INSERT INTO review_operations(id,workspace_id,user_id,run_id,stage,state,created_at,updated_at)
    SELECT ?,?,?,?,?,'pending',?,? WHERE ${owner} AND NOT EXISTS(SELECT 1 FROM review_operations WHERE run_id=? AND state IN ('pending','unknown'))`,
    [
      id,
      deps.tenant.workspaceId,
      deps.tenant.userId,
      runId,
      stage,
      now,
      now,
      ...params(deps, runId, lease),
      runId,
    ],
  );
  if (result.rowsAffected !== 1)
    throw new Error("This review has a pending request or lost its execution owner.");
  return id;
}
export async function recover(deps: Db, runId: string, lease: string): Promise<void> {
  // Called only by explicit Continue, after the prior run has stopped/interrupted. No request
  // is repeated here; the UI warning says a fresh request can incur another charge.
  await deps.db.execute(
    `UPDATE review_operations SET state='discarded',result=?,updated_at=? WHERE workspace_id=? AND user_id=? AND run_id=? AND state IN ('pending','unknown') AND ${owner}`,
    [
      JSON.stringify({
        reason:
          "Explicit continuation discarded an unavailable prior response; its billing hold remains.",
      }),
      Date.now(),
      deps.tenant.workspaceId,
      deps.tenant.userId,
      runId,
      ...params(deps, runId, lease),
    ],
  );
}
export async function failOperation(
  deps: Db,
  runId: string,
  lease: string,
  id: string,
  unbilled: boolean,
): Promise<void> {
  await deps.db.execute(
    `UPDATE review_operations SET state=?,updated_at=? WHERE id=? AND run_id=? AND state='pending' AND ${owner}`,
    [unbilled ? "not_dispatched" : "unknown", Date.now(), id, runId, ...params(deps, runId, lease)],
  );
}
export async function commitOperation(
  deps: Db,
  runId: string,
  lease: string,
  id: string,
  state: ReviewState,
  result: { text: string; requestId: string; costMicroUsd: number; historyText: string },
): Promise<void> {
  const now = Date.now(),
    { workspaceId: ws, userId: user } = deps.tenant;
  const guard = `${owner} AND EXISTS(SELECT 1 FROM review_operations WHERE id=? AND run_id=? AND state='pending')`;
  const args = [...params(deps, runId, lease), id, runId];
  const writes: SqlStatement[] = [
    {
      sql: `UPDATE review_state SET data=?,updated_at=? WHERE workspace_id=? AND user_id=? AND run_id=? AND ${guard}`,
      params: [JSON.stringify(state), now, ws, user, runId, ...args],
    },
    {
      sql: `INSERT INTO run_steps(id,workspace_id,user_id,run_id,seq,kind,text,request_id,cost_micro_usd,created_at,updated_at)
    SELECT ?,?,?,?,COALESCE((SELECT MAX(seq) FROM run_steps WHERE run_id=?),0)+1,'model',?,?,?,?,? WHERE ${guard}
    AND NOT EXISTS(SELECT 1 FROM run_steps WHERE run_id=? AND request_id=?)`,
      params: [
        id,
        ws,
        user,
        runId,
        runId,
        result.historyText,
        result.requestId,
        result.costMicroUsd,
        now,
        now,
        ...args,
        runId,
        result.requestId,
      ],
    },
    {
      sql: `UPDATE review_operations SET state='complete',result=?,updated_at=? WHERE id=? AND run_id=? AND state='pending' AND ${owner}`,
      params: [JSON.stringify(result), now, id, runId, ...params(deps, runId, lease)],
    },
  ];
  const written = await deps.db.batch(writes);
  if (
    written[0]?.rowsAffected !== 1 ||
    written[1]?.rowsAffected !== 1 ||
    written[2]?.rowsAffected !== 1
  )
    throw new Error("The review response was already committed or lost its execution owner.");
}
export async function park(
  deps: Db,
  runId: string,
  lease: string,
  state: ReviewState,
  status: "done" | "paused" | "stopped",
  note: string | null,
): Promise<void> {
  const now = Date.now(),
    { workspaceId: ws, userId: user } = deps.tenant;
  const written = await deps.db.batch([
    {
      sql: `UPDATE review_state SET data=?,updated_at=? WHERE workspace_id=? AND user_id=? AND run_id=? AND ${owner}`,
      params: [JSON.stringify(state), now, ws, user, runId, ...params(deps, runId, lease)],
    },
    {
      sql: `UPDATE runs SET status=?,note=?,routing_stage=?,updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND ${owner}`,
      params: [
        status,
        note,
        status === "done"
          ? "complete"
          : state.stage === "plan"
            ? "plan"
            : state.stage === "final"
              ? "synthesis"
              : "work",
        now,
        ws,
        user,
        runId,
        ...params(deps, runId, lease),
      ],
    },
    {
      sql: "UPDATE review_state SET lease=NULL,updated_at=? WHERE workspace_id=? AND user_id=? AND run_id=? AND lease=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND status=?)",
      params: [now, ws, user, runId, lease, runId, status],
    },
  ]);
  if (written[0]?.rowsAffected !== 1 || written[1]?.rowsAffected !== 1)
    throw new Error("The review lost its execution owner before publication.");
}
