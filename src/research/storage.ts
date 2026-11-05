/** Owner-local coordination; completed steps and report artifacts use the existing history stores. */
import type { Tenant } from "@/storage/defaults";
import { uuidv7 } from "@/storage/ids";
import type { SqlDb, SqlStatement } from "@/storage/sql";
import type { RunStatus } from "@/storage/runs";
import type { ResearchOperation, ResearchState } from "./types";

export interface ResearchDb {
  db: SqlDb;
  tenant: Tenant;
}
const owner = `EXISTS(SELECT 1 FROM research_state s JOIN runs r ON r.id=s.run_id AND r.workspace_id=s.workspace_id
 WHERE s.workspace_id=? AND s.user_id=? AND s.run_id=? AND s.lease=? AND r.status='running'
 AND (r.sync_owner IS NULL OR r.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=r.workspace_id)))`;
const params = (deps: ResearchDb, runId: string, lease: string) => [
  deps.tenant.workspaceId,
  deps.tenant.userId,
  runId,
  lease,
];

export async function checkpoint(
  deps: ResearchDb,
  runId: string,
): Promise<{ state: ResearchState; pause: boolean; stop: boolean; lease: string | null }> {
  const row = (
    await deps.db.select<{
      data: string;
      pause_requested: number;
      stop_requested: number;
      lease: string | null;
    }>(
      "SELECT data,pause_requested,stop_requested,lease FROM research_state WHERE workspace_id=? AND user_id=? AND run_id=?",
      [deps.tenant.workspaceId, deps.tenant.userId, runId],
    )
  )[0];
  if (!row) throw new Error("Research checkpoint not found.");
  const value = JSON.parse(row.data) as Partial<ResearchState>;
  if (
    value.version !== 1 ||
    typeof value.stage !== "string" ||
    !["plan", "search", "read", "synthesis", "verify", "publish", "finished"].includes(
      value.stage,
    ) ||
    ![value.modelCalls, value.searches, value.reads, value.elapsedMs, value.queryIndex].every(
      (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
    ) ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.queries) ||
    !Array.isArray(value.findings)
  )
    throw new Error("Research checkpoint is incompatible or malformed. Pending work is preserved.");
  return {
    state: value as ResearchState,
    pause: row.pause_requested === 1,
    stop: row.stop_requested === 1,
    lease: row.lease,
  };
}
export async function initialize(
  deps: ResearchDb,
  runId: string,
  state: ResearchState,
): Promise<void> {
  const now = Date.now();
  await deps.db.execute(
    "INSERT INTO research_state(run_id,workspace_id,user_id,data,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    [runId, deps.tenant.workspaceId, deps.tenant.userId, JSON.stringify(state), now, now],
  );
}
export async function claim(deps: ResearchDb, runId: string): Promise<string> {
  const lease = uuidv7();
  const { workspaceId: ws, userId: user } = deps.tenant;
  const now = Date.now();
  const result = await deps.db.batch([
    {
      sql: `UPDATE research_state SET lease=?,
      pause_requested=CASE WHEN (SELECT status FROM runs WHERE id=research_state.run_id)='running' THEN pause_requested ELSE 0 END,
      stop_requested=CASE WHEN (SELECT status FROM runs WHERE id=research_state.run_id)='running' THEN stop_requested ELSE 0 END,updated_at=? WHERE workspace_id=? AND user_id=? AND run_id=?
   AND json_extract(data,'$.stage')!='finished' AND EXISTS(SELECT 1 FROM runs r WHERE r.id=research_state.run_id AND r.workspace_id=? AND r.user_id=?
    AND r.status!='done' AND (research_state.lease IS NULL OR r.status!='running')
    AND (r.sync_owner IS NULL OR r.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=r.workspace_id)))`,
      params: [lease, now, ws, user, runId, ws, user],
    },
    {
      sql: "UPDATE runs SET status='running',note=NULL,started_at=?,waited_ms=0,updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND EXISTS(SELECT 1 FROM research_state WHERE run_id=? AND lease=?)",
      params: [now, now, ws, user, runId, runId, lease],
    },
  ]);
  if (result[0]?.rowsAffected !== 1)
    throw new Error("Research is already running, finished, or owned by another installation.");
  return lease;
}
function saveStatement(
  deps: ResearchDb,
  runId: string,
  lease: string,
  state: ResearchState,
  extra = "",
  values: (string | number | null)[] = [],
): SqlStatement {
  return {
    sql: `UPDATE research_state SET data=?,updated_at=? WHERE workspace_id=? AND user_id=? AND run_id=? AND ${owner}${extra}`,
    params: [
      JSON.stringify(state),
      Date.now(),
      deps.tenant.workspaceId,
      deps.tenant.userId,
      runId,
      ...params(deps, runId, lease),
      ...values,
    ],
  };
}
export async function save(
  deps: ResearchDb,
  runId: string,
  lease: string,
  state: ResearchState,
): Promise<void> {
  const result = await deps.db.batch([saveStatement(deps, runId, lease, state)]);
  if (result[0]?.rowsAffected !== 1)
    throw new Error("Research execution ownership changed; no further request was sent.");
}
export async function operations(deps: ResearchDb, runId: string): Promise<ResearchOperation[]> {
  return deps.db.select<ResearchOperation>(
    "SELECT id,seq,kind,state,input,result FROM research_operations WHERE workspace_id=? AND user_id=? AND run_id=? ORDER BY seq",
    [deps.tenant.workspaceId, deps.tenant.userId, runId],
  );
}
export async function beginOperation(
  deps: ResearchDb,
  runId: string,
  lease: string,
  state: ResearchState,
  kind: ResearchOperation["kind"],
  input: unknown,
): Promise<string> {
  const id = uuidv7();
  const now = Date.now();
  const { workspaceId: ws, userId: user } = deps.tenant;
  const result = await deps.db.batch([
    saveStatement(deps, runId, lease, state, " AND pause_requested=0 AND stop_requested=0"),
    {
      sql: `INSERT INTO research_operations(id,workspace_id,user_id,run_id,seq,kind,state,input,created_at,updated_at)
   SELECT ?,?,?,?,COALESCE((SELECT MAX(seq) FROM research_operations WHERE workspace_id=? AND run_id=?),0)+1,?,'pending',?,?,? WHERE ${owner} AND EXISTS(SELECT 1 FROM research_state WHERE run_id=? AND lease=? AND pause_requested=0 AND stop_requested=0)`,
      params: [
        id,
        ws,
        user,
        runId,
        ws,
        runId,
        kind,
        JSON.stringify(input),
        now,
        now,
        ...params(deps, runId, lease),
        runId,
        lease,
      ],
    },
  ]);
  if (result[0]?.rowsAffected !== 1 || result[1]?.rowsAffected !== 1)
    throw new Error("Research operation could not claim its execution owner.");
  return id;
}
export async function completeOperation(
  deps: ResearchDb,
  runId: string,
  lease: string,
  state: ResearchState,
  id: string,
  result: unknown,
  step?: { text: string; requestId: string } | { url: string; output: string; isError?: boolean },
): Promise<void> {
  const { workspaceId: ws, userId: user } = deps.tenant;
  const now = Date.now();
  const pending =
    " AND EXISTS(SELECT 1 FROM research_operations WHERE id=? AND run_id=? AND state='pending')";
  const statements: SqlStatement[] = [
    saveStatement(deps, runId, lease, state, pending, [id, runId]),
  ];
  if (step) {
    const model = "text" in step;
    statements.push({
      sql: `INSERT INTO run_steps(id,workspace_id,user_id,run_id,seq,kind,text,request_id,cost_micro_usd,tool_name,tool_call_id,input,output,is_error,created_at,updated_at)
   SELECT ?,?,?,?,COALESCE((SELECT MAX(seq) FROM run_steps WHERE workspace_id=? AND run_id=?),0)+1,?,?,?,
    COALESCE((SELECT cost_micro_usd FROM request_log WHERE workspace_id=? AND id=?),0),?,?,?,?,?,?,?
    WHERE ${owner}${pending} ON CONFLICT(id) DO NOTHING`,
      params: [
        id,
        ws,
        user,
        runId,
        ws,
        runId,
        model ? "model" : "tool",
        model ? step.text : null,
        model ? step.requestId : null,
        ws,
        model ? step.requestId : null,
        model ? null : "fetch_url",
        model ? null : id,
        model ? null : JSON.stringify({ url: step.url }),
        model ? null : step.output,
        !model && step.isError ? 1 : 0,
        now,
        now,
        ...params(deps, runId, lease),
        id,
        runId,
      ],
    });
  }
  statements.push({
    sql: `UPDATE research_operations SET state=CASE WHEN ?=0 OR EXISTS(SELECT 1 FROM run_steps WHERE id=? AND run_id=?) THEN 'complete' ELSE 'missing_step' END,result=?,updated_at=? WHERE id=? AND run_id=? AND state='pending' AND ${owner}`,
    params: [
      step ? 1 : 0,
      id,
      runId,
      JSON.stringify(result),
      now,
      id,
      runId,
      ...params(deps, runId, lease),
    ],
  });
  const done = await deps.db.batch(statements);
  if (done[0]?.rowsAffected !== 1)
    throw new Error("Research operation lost its owner or was already committed.");
}
/** Recovery metadata and its cursor advance are one transaction, so a second resume cannot skip twice. */
export async function repairOperation(
  deps: ResearchDb,
  runId: string,
  lease: string,
  state: ResearchState,
  id: string,
  status: ResearchOperation["state"],
  result: Record<string, unknown>,
): Promise<void> {
  const available =
    " AND EXISTS(SELECT 1 FROM research_operations WHERE id=? AND run_id=? AND state IN ('pending','unknown','lost') AND COALESCE(json_extract(result,'$.recovered'),0)=0)";
  const done = await deps.db.batch([
    saveStatement(deps, runId, lease, state, available, [id, runId]),
    {
      sql: `UPDATE research_operations SET state=?,result=?,updated_at=? WHERE id=? AND run_id=? AND state IN ('pending','unknown','lost') AND COALESCE(json_extract(result,'$.recovered'),0)=0 AND ${owner}`,
      params: [
        status,
        JSON.stringify(result),
        Date.now(),
        id,
        runId,
        ...params(deps, runId, lease),
      ],
    },
  ]);
  if (done[0]?.rowsAffected !== 1 || done[1]?.rowsAffected !== 1)
    throw new Error("Research recovery was already committed or lost its owner.");
}
export async function park(
  deps: ResearchDb,
  runId: string,
  lease: string,
  state: ResearchState,
  status: Exclude<RunStatus, "running">,
  note: string | null,
): Promise<void> {
  const now = Date.now();
  const result = await deps.db.batch([
    saveStatement(deps, runId, lease, state),
    {
      sql: `UPDATE runs SET status=?,note=?,routing_stage=?,updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND ${owner}`,
      params: [
        status,
        note,
        status === "done"
          ? "complete"
          : state.stage === "plan"
            ? "plan"
            : state.stage === "synthesis" || state.stage === "verify"
              ? "synthesis"
              : "work",
        now,
        ...params(deps, runId, lease).slice(0, 3),
        ...params(deps, runId, lease),
      ],
    },
    {
      sql: "UPDATE research_state SET lease=NULL,updated_at=? WHERE workspace_id=? AND user_id=? AND run_id=? AND lease=?",
      params: [now, ...params(deps, runId, lease)],
    },
  ]);
  if (result[0]?.rowsAffected !== 1) throw new Error("Research execution ownership changed.");
}
export async function requestControl(
  deps: ResearchDb,
  runId: string,
  action: "pause" | "stop",
): Promise<void> {
  // Fixed column names; caller input never supplies SQL or acquires a grant.
  const column = action === "pause" ? "pause_requested" : "stop_requested";
  await deps.db.execute(
    `UPDATE research_state SET ${column}=1,updated_at=? WHERE workspace_id=? AND user_id=? AND run_id=? AND EXISTS(SELECT 1 FROM runs r WHERE r.id=research_state.run_id AND r.status='running' AND (r.sync_owner IS NULL OR r.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=r.workspace_id)))`,
    [Date.now(), deps.tenant.workspaceId, deps.tenant.userId, runId],
  );
}

/** Stable request ID and all related records commit together. A racing duplicate rolls back its messages. */
export async function createResearch(
  deps: ResearchDb,
  input: {
    id: string;
    threadId: string;
    projectId: string | null;
    parentId: string | null;
    task: string;
    provider: string;
    model: string;
    bestProvider: string;
    bestModel: string;
    capMicroUsd: number;
  },
  state: ResearchState,
): Promise<void> {
  const { workspaceId: ws, userId: user } = deps.tenant;
  const now = Date.now(),
    question = uuidv7(now),
    answer = uuidv7(now);
  await deps.db.batch([
    {
      sql: `INSERT INTO messages(id,workspace_id,user_id,thread_id,parent_id,role,content,status,created_at,updated_at)
   SELECT ?,?,?,id,?,'user',?,'complete',?,? FROM threads WHERE workspace_id=? AND user_id=? AND id=? AND deleted_at IS NULL AND active_leaf_id IS ?`,
      params: [
        question,
        ws,
        user,
        input.parentId,
        input.task,
        now,
        now,
        ws,
        user,
        input.threadId,
        input.parentId,
      ],
    },
    {
      sql: "INSERT INTO messages(id,workspace_id,user_id,thread_id,parent_id,role,content,status,provider,model,created_at,updated_at) VALUES(?,?,?,?,?,'assistant','','streaming',?,?,?,?)",
      params: [
        answer,
        ws,
        user,
        input.threadId,
        question,
        input.bestProvider,
        input.bestModel,
        now,
        now,
      ],
    },
    {
      sql: `INSERT INTO runs(id,workspace_id,user_id,project_id,thread_id,message_id,task,kind,mode,provider,model,status,cap_micro_usd,routing_stage,created_at,updated_at,started_at)
   VALUES(?,?,?,?,?,?,?,'research','plan',?,?,'running',?,'plan',?,?,?)`,
      params: [
        input.id,
        ws,
        user,
        input.projectId,
        input.threadId,
        answer,
        input.task,
        input.provider,
        input.model,
        input.capMicroUsd,
        now,
        now,
        now,
      ],
    },
    {
      sql: "INSERT INTO research_state(run_id,workspace_id,user_id,data,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      params: [input.id, ws, user, JSON.stringify(state), now, now],
    },
    {
      sql: "UPDATE threads SET active_leaf_id=?,last_message_at=?,updated_at=? WHERE workspace_id=? AND user_id=? AND id=?",
      params: [answer, now, now, ws, user, input.threadId],
    },
  ]);
}

/** Cheap polling: do not reload source bodies while waiting for an operation. */
export async function controls(
  deps: ResearchDb,
  runId: string,
): Promise<{ lease: string | null; pause: boolean; stop: boolean }> {
  const row = (
    await deps.db.select<{ lease: string | null; pause_requested: number; stop_requested: number }>(
      "SELECT lease,pause_requested,stop_requested FROM research_state WHERE workspace_id=? AND user_id=? AND run_id=?",
      [deps.tenant.workspaceId, deps.tenant.userId, runId],
    )
  )[0];
  if (!row) throw new Error("Research was deleted.");
  return { lease: row.lease, pause: row.pause_requested === 1, stop: row.stop_requested === 1 };
}
