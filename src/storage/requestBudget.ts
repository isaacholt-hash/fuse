/** Owner-local dispatch holds. No timeout silently releases an ambiguously billed operation. */
import type { Tenant } from "./defaults";
import { requestStatement, type RequestLogEntry } from "./requestLog";
import type { SqlDb } from "./sql";

export interface Reservation {
  id: string;
  runId: string | null;
  provider: string;
  model: string;
  purpose: RequestLogEntry["purpose"];
  threadId: string | null;
  messageId: string | null;
  projectId?: string | null;
  boundMicroUsd: number;
}

const pending = `(SELECT COALESCE(SUM(MAX(h.bound_micro_usd-COALESCE(l.cost_micro_usd,0),0)),0)
 FROM request_reservations h LEFT JOIN request_log l ON l.id=h.request_id AND l.workspace_id=h.workspace_id
 WHERE h.workspace_id=r.workspace_id AND h.run_id=r.id AND h.state IN ('held','dispatched','unknown'))`;

export async function reserveRequest(db: SqlDb, tenant: Tenant, r: Reservation): Promise<boolean> {
  if (!Number.isSafeInteger(r.boundMicroUsd) || r.boundMicroUsd < 0)
    throw new Error("A request needs a non-negative integer cost bound.");
  const now = Date.now();
  const result = await db.execute(
    `INSERT INTO request_reservations(id,workspace_id,user_id,run_id,provider,model,purpose,
      thread_id,message_id,project_id,bound_micro_usd,state,created_at,updated_at)
     SELECT ?,?,?,?,?,?,?,?,?,?,?,'held',?,?
     WHERE (? IS NULL OR EXISTS (SELECT 1 FROM runs r WHERE r.workspace_id=? AND r.user_id=?
       AND r.id=? AND r.status='running'
       AND (r.sync_owner IS NULL OR r.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=r.workspace_id))
       AND r.cap_micro_usd-r.spent_micro_usd-${pending}>=?))
     ON CONFLICT(id) DO NOTHING`,
    [
      r.id,
      tenant.workspaceId,
      tenant.userId,
      r.runId,
      r.provider,
      r.model,
      r.purpose,
      r.threadId,
      r.messageId,
      r.projectId ?? null,
      r.boundMicroUsd,
      now,
      now,
      r.runId,
      tenant.workspaceId,
      tenant.userId,
      r.runId,
      r.boundMicroUsd,
    ],
  );
  return result.rowsAffected === 1;
}

/** The conditional transition is the single dispatch claim, including duplicate UI delivery. */
export async function dispatchRequest(db: SqlDb, tenant: Tenant, id: string): Promise<boolean> {
  const result = await db.execute(
    `UPDATE request_reservations SET state='dispatched',updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND state='held'
      AND (run_id IS NULL OR EXISTS (SELECT 1 FROM runs r WHERE r.workspace_id=request_reservations.workspace_id
        AND r.id=request_reservations.run_id AND r.status='running' AND r.spent_micro_usd+${pending}<=r.cap_micro_usd
        AND (r.sync_owner IS NULL OR r.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=r.workspace_id))))`,
    [Date.now(), tenant.workspaceId, tenant.userId, id],
  );
  return result.rowsAffected === 1;
}

/** Only a request proven not to have been dispatched can be cancelled without retaining a hold. */
export async function releaseRequest(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  await db.execute(
    "UPDATE request_reservations SET state='released',updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND state='held'",
    [Date.now(), tenant.workspaceId, tenant.userId, id],
  );
}

/** Receipt, cost total and release of unused exposure commit together. Repeated delivery is harmless. */
export async function settleRequest(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  entry: RequestLogEntry,
): Promise<string> {
  const now = Date.now();
  const state = entry.billingState;
  if (!Number.isSafeInteger(entry.usage.costMicroUsd) || entry.usage.costMicroUsd < 0)
    throw new Error("Settlement needs a non-negative integer cost.");
  if (!state || state === "legacy") throw new Error("Settlement needs an explicit billing state.");
  const insert = requestStatement(tenant, { ...entry, attemptId: id }, id, now);
  const marker = "VALUES (";
  const index = insert.sql.indexOf(marker);
  if (index < 0) throw new Error("Invalid receipt statement.");
  const slots = insert.sql
    .slice(index + marker.length)
    .trim()
    .replace(/\)$/, "");
  const live =
    "SELECT 1 FROM request_reservations WHERE workspace_id=? AND user_id=? AND id=? AND provider=? AND state='dispatched'";
  const match = [tenant.workspaceId, tenant.userId, id, entry.provider];
  const result = await db.batch([
    {
      sql: `${insert.sql.slice(0, index)} SELECT ${slots} WHERE EXISTS (${live}) ON CONFLICT(id) DO NOTHING`,
      params: [...(insert.params ?? []), ...match],
    },
    {
      sql: `UPDATE runs SET spent_micro_usd=spent_micro_usd+?,updated_at=? WHERE workspace_id=? AND user_id=?
      AND id=(SELECT run_id FROM request_reservations WHERE workspace_id=? AND id=?)
      AND EXISTS (${live}) AND EXISTS (SELECT 1 FROM request_log WHERE workspace_id=? AND id=? AND attempt_id=?)`,
      params: [
        entry.usage.costMicroUsd,
        now,
        tenant.workspaceId,
        tenant.userId,
        tenant.workspaceId,
        id,
        ...match,
        tenant.workspaceId,
        id,
        id,
      ],
    },
    {
      sql: `UPDATE request_reservations SET state=?,request_id=?,updated_at=? WHERE workspace_id=? AND user_id=? AND id=?
      AND state='dispatched' AND provider=? AND EXISTS (SELECT 1 FROM request_log WHERE workspace_id=? AND id=? AND attempt_id=?)`,
      params: [
        state === "unknown" || state === "estimated" ? "unknown" : "settled",
        id,
        now,
        tenant.workspaceId,
        tenant.userId,
        id,
        entry.provider,
        tenant.workspaceId,
        id,
        id,
      ],
    },
  ]);
  if (result[0]?.rowsAffected === 0) {
    const prior = await db.select<{ id: string }>(
      "SELECT id FROM request_log WHERE workspace_id=? AND user_id=? AND id=? AND attempt_id=?",
      [tenant.workspaceId, tenant.userId, id, id],
    );
    if (!prior.length) throw new Error("No dispatched request belongs to this receipt.");
  }
  return id;
}

export async function runExposure(
  db: SqlDb,
  tenant: Tenant,
  runId: string,
): Promise<{ spent: number; held: number; cap: number }> {
  const rows = await db.select<{ spent: number; held: number; cap: number }>(
    `SELECT spent_micro_usd AS spent,cap_micro_usd AS cap,${pending} AS held FROM runs r WHERE workspace_id=? AND user_id=? AND id=?`,
    [tenant.workspaceId, tenant.userId, runId],
  );
  if (!rows[0]) throw new Error("Run not found.");
  return rows[0];
}

/** Startup recovery only: no worker is running yet. A dispatched request may already be billed. */
export async function interruptRequests(db: SqlDb, tenant: Tenant): Promise<void> {
  const now = Date.now();
  await db.batch([
    {
      sql: `INSERT INTO request_log(id,workspace_id,user_id,thread_id,message_id,purpose,provider,model,attempt,
      cost_micro_usd,billing_state,attempt_id,project_id,created_at,updated_at)
      SELECT id,workspace_id,user_id,thread_id,message_id,purpose,provider,model,1,0,'unknown',id,project_id,created_at,?
      FROM request_reservations WHERE workspace_id=? AND user_id=? AND purpose!='transcribe' AND state='dispatched' ON CONFLICT(id) DO NOTHING`,
      params: [now, tenant.workspaceId, tenant.userId],
    },
    {
      sql: "UPDATE request_reservations SET state='unknown',request_id=id,updated_at=? WHERE workspace_id=? AND user_id=? AND purpose!='transcribe' AND state='dispatched'",
      params: [now, tenant.workspaceId, tenant.userId],
    },
    {
      sql: "UPDATE request_reservations SET state='released',updated_at=? WHERE workspace_id=? AND user_id=? AND purpose!='transcribe' AND state='held'",
      params: [now, tenant.workspaceId, tenant.userId],
    },
  ]);
}
