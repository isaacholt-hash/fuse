/** Budgets (CO-03) and the alerts already shown for them (CO-07). Money in micro-dollars. */
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export type BudgetPeriod = "day" | "month";

export interface Budget {
  id: string;
  projectId: string | null;
  period: BudgetPeriod;
  limitMicro: number;
  hardStop: boolean;
  allowUntil: number | null;
}

export interface NewBudget {
  projectId: string | null;
  period: BudgetPeriod;
  limitMicro: number;
  hardStop: boolean;
}

export async function listBudgets(db: SqlDb, tenant: Tenant): Promise<Budget[]> {
  const rows = await db.select<{
    id: string;
    project_id: string | null;
    period: BudgetPeriod;
    limit_micro_usd: number;
    hard_stop: number;
    allow_until: number | null;
  }>(
    `SELECT id, project_id, period, limit_micro_usd, hard_stop, allow_until FROM budgets
     WHERE workspace_id = ? ORDER BY created_at`,
    [tenant.workspaceId],
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    period: r.period,
    limitMicro: r.limit_micro_usd,
    hardStop: r.hard_stop === 1,
    allowUntil: r.allow_until,
  }));
}

export async function addBudget(db: SqlDb, tenant: Tenant, b: NewBudget): Promise<string> {
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO budgets (id, workspace_id, user_id, scope, project_id, period, limit_micro_usd,
       hard_stop, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenant.workspaceId,
      tenant.userId,
      b.projectId ? "project" : "global",
      b.projectId,
      b.period,
      Math.round(b.limitMicro),
      b.hardStop ? 1 : 0,
      now,
      now,
    ],
  );
  return id;
}

export async function deleteBudget(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  await db.execute(`DELETE FROM budget_events WHERE workspace_id = ? AND budget_id = ?`, [
    tenant.workspaceId,
    id,
  ]);
  await db.execute(`DELETE FROM budgets WHERE workspace_id = ? AND id = ?`, [
    tenant.workspaceId,
    id,
  ]);
}

/** The one-click temporary raise: no asking and no downshift until `until`. */
export async function allowBudgetUntil(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  until: number,
): Promise<void> {
  await db.execute(
    `UPDATE budgets SET allow_until = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [until, Date.now(), tenant.workspaceId, id],
  );
}

/** What was spent since `since`, everywhere or in one project (via the call's thread). */
/** MM-09: spend per provider since a time (every call on its key, any purpose), micro-dollars. */
export async function spentByProvider(
  db: SqlDb,
  tenant: Tenant,
  since: number,
): Promise<Record<string, number>> {
  const rows = await db.select<{ provider: string; total: number | null }>(
    `SELECT provider, SUM(cost_micro_usd) AS total FROM request_log
     WHERE workspace_id = ? AND created_at >= ? GROUP BY provider`,
    [tenant.workspaceId, since],
  );
  return Object.fromEntries(rows.map((r) => [r.provider, r.total ?? 0]));
}

export async function spentSince(
  db: SqlDb,
  tenant: Tenant,
  since: number,
  projectId: string | null = null,
): Promise<number> {
  const rows = await db.select<{ total: number | null }>(
    projectId === null
      ? `SELECT SUM(cost_micro_usd) AS total FROM request_log
         WHERE workspace_id = ? AND created_at >= ?`
      : `SELECT SUM(r.cost_micro_usd) AS total FROM request_log r
         JOIN threads t ON t.id = r.thread_id
         WHERE r.workspace_id = ? AND r.created_at >= ? AND t.project_id = ?`,
    projectId === null ? [tenant.workspaceId, since] : [tenant.workspaceId, since, projectId],
  );
  return rows[0]?.total ?? 0;
}

/** Spend per local day, oldest first, for the `days` days before `before` (for CO-07). */
export async function dailySpend(
  db: SqlDb,
  tenant: Tenant,
  dayStarts: readonly number[],
): Promise<number[]> {
  const out: number[] = [];
  for (const [i, start] of dayStarts.entries()) {
    const end = dayStarts[i + 1];
    const rows = await db.select<{ total: number | null }>(
      `SELECT SUM(cost_micro_usd) AS total FROM request_log
       WHERE workspace_id = ? AND created_at >= ? ${end === undefined ? "" : "AND created_at < ?"}`,
      end === undefined ? [tenant.workspaceId, start] : [tenant.workspaceId, start, end],
    );
    out.push(rows[0]?.total ?? 0);
  }
  return out;
}

export type AlertKind = "50" | "80" | "100" | "anomaly";

/** Records an alert; false when it was already shown for this budget and period. */
export async function recordAlert(
  db: SqlDb,
  tenant: Tenant,
  budgetId: string | null,
  kind: AlertKind,
  periodStart: number,
): Promise<boolean> {
  const seen = await db.select<{ n: number }>(
    `SELECT COUNT(*) AS n FROM budget_events
     WHERE workspace_id = ? AND COALESCE(budget_id, '') = ? AND kind = ? AND period_start = ?`,
    [tenant.workspaceId, budgetId ?? "", kind, periodStart],
  );
  if ((seen[0]?.n ?? 0) > 0) return false;
  const now = Date.now();
  await db.execute(
    `INSERT INTO budget_events (id, workspace_id, user_id, budget_id, kind, period_start,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv7(now), tenant.workspaceId, tenant.userId, budgetId, kind, periodStart, now, now],
  );
  return true;
}
