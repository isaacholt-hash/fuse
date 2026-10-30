/** Shadow checks of the local model (M7 step 9, LL-09): timings and agreement, never text. */
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export interface ShadowRecord {
  purpose: string;
  localModel: string;
  cloudModel: string;
  localMs: number;
  cloudMs: number;
  localChars: number;
  cloudChars: number;
  same: boolean;
}

export async function recordShadow(db: SqlDb, tenant: Tenant, r: ShadowRecord): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO local_shadow (id, workspace_id, user_id, purpose, local_model, cloud_model,
       local_ms, cloud_ms, local_chars, cloud_chars, same, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv7(now),
      tenant.workspaceId,
      tenant.userId,
      r.purpose,
      r.localModel,
      r.cloudModel,
      Math.round(r.localMs),
      Math.round(r.cloudMs),
      r.localChars,
      r.cloudChars,
      r.same ? 1 : 0,
      now,
    ],
  );
}

export interface ShadowSummary {
  checks: number;
  same: number;
  /** Median milliseconds; null with no checks. */
  localP50: number | null;
  cloudP50: number | null;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? null;
};

export async function shadowSummary(
  db: SqlDb,
  tenant: Tenant,
  since: number,
): Promise<ShadowSummary> {
  const rows = await db.select<{ local_ms: number; cloud_ms: number; same: number }>(
    `SELECT local_ms, cloud_ms, same FROM local_shadow WHERE workspace_id = ? AND created_at >= ?`,
    [tenant.workspaceId, since],
  );
  return {
    checks: rows.length,
    same: rows.filter((r) => r.same === 1).length,
    localP50: median(rows.map((r) => r.local_ms)),
    cloudP50: median(rows.map((r) => r.cloud_ms)),
  };
}
