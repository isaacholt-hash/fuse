/** Every billed provider call since a time, with what the dashboard groups by (CO-02). */
import type { Tenant } from "./defaults";
import type { SqlDb } from "./sql";

export interface UsageRecord {
  at: number;
  provider: string;
  model: string;
  /** The answer's tier; null for housekeeping and calls from before routing. */
  tier: string | null;
  purpose: string;
  projectId: string | null;
  /** What the classifier read (Auto answers only). */
  intent: string | null;
  costMicro: number;
}

export async function listUsage(db: SqlDb, tenant: Tenant, since: number): Promise<UsageRecord[]> {
  const rows = await db.select<{
    created_at: number;
    provider: string;
    model: string;
    tier: string | null;
    purpose: string;
    project_id: string | null;
    route_intent: string | null;
    cost_micro_usd: number;
  }>(
    `SELECT r.created_at, r.provider, r.model, r.tier, r.purpose, t.project_id, m.route_intent,
            r.cost_micro_usd
     FROM request_log r
     LEFT JOIN threads t ON t.id = r.thread_id
     LEFT JOIN messages m ON m.id = r.message_id
     WHERE r.workspace_id = ? AND r.created_at >= ?
     ORDER BY r.created_at`,
    [tenant.workspaceId, since],
  );
  return rows.map((r) => ({
    at: r.created_at,
    provider: r.provider,
    model: r.model,
    tier: r.tier,
    purpose: r.purpose,
    projectId: r.project_id,
    intent: r.route_intent,
    costMicro: r.cost_micro_usd,
  }));
}

/** Cache tokens read and written per model since `since` (for CO-04's cache savings). */
export async function cacheTokensSince(
  db: SqlDb,
  tenant: Tenant,
  since: number,
): Promise<{ provider: string; model: string; cached: number; written: number }[]> {
  const rows = await db.select<{
    provider: string;
    model: string;
    cached: number;
    written: number;
  }>(
    `SELECT provider, model, SUM(cached_input_tokens) AS cached, SUM(cache_write_tokens) AS written
     FROM request_log WHERE workspace_id = ? AND created_at >= ?
     GROUP BY provider, model`,
    [tenant.workspaceId, since],
  );
  return rows;
}

/**
 * What routed answers since `since` would have cost on Best, minus what they cost (RT-09's
 * estimate, summed). Answers from before routing have no estimate and aren't counted.
 */
export async function bestExtraSince(db: SqlDb, tenant: Tenant, since: number): Promise<number> {
  const rows = await db.select<{ extra: number | null }>(
    `SELECT SUM(best_cost_micro_usd - cost_micro_usd) AS extra FROM messages
     WHERE workspace_id = ? AND created_at >= ? AND role = 'assistant'
       AND best_cost_micro_usd IS NOT NULL`,
    [tenant.workspaceId, since],
  );
  return rows[0]?.extra ?? 0;
}
