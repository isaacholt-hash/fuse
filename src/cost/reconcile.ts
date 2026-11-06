/**
 * M18.4 (CO-06, MM-12): FUSE's own logged cost beside each provider's report, per UTC day.
 * Only matching periods, currency (USD) and scopes are compared. A report is never counted as
 * spend, and differences are explained, not attributed to individual FUSE requests (the
 * reports don't carry FUSE's request ids).
 */
import type { Tenant } from "@/storage/defaults";
import type { SqlDb } from "@/storage/sql";

export type ReconcileStatus = "match" | "provider_higher" | "fuse_higher" | "lagging" | "no_report";

export interface ReconcileDay {
  provider: "openai" | "anthropic";
  /** UTC midnight, ms. */
  day: number;
  fuseMicro: number;
  reportedMicro: number | null;
  /** Reported minus FUSE; null without a report. */
  diffMicro: number | null;
  status: ReconcileStatus;
  /** Where the report came from for this day. */
  source: "api" | "csv" | null;
}

export interface ReconcileView {
  days: ReconcileDay[];
  /** Report rows in other currencies, left out of the comparison. */
  otherCurrencyRows: number;
  /** The provider's own "data refreshed at", when it says (Anthropic). */
  refreshedAt: Partial<Record<"openai" | "anthropic", number>>;
  /** Scopes the comparison is limited to, per provider; empty means all. */
  scopes: Partial<Record<"openai" | "anthropic", string[]>>;
}

const DAY = 86_400_000;
/** Within a cent, or 2% of the larger side, counts as matching. */
const TOLERANCE_MICRO = 10_000;
const TOLERANCE_SHARE = 0.02;

export interface FuseDay {
  provider: string;
  day: number;
  micro: number;
}
export interface ReportDay {
  provider: string;
  day: number;
  source: "api" | "csv";
  micro: number;
}

/** Pure comparison; `now` and `refreshedAt` decide which days may still be incomplete. */
export function reconcile(
  fuse: readonly FuseDay[],
  reports: readonly ReportDay[],
  refreshedAt: Partial<Record<"openai" | "anthropic", number>>,
  now: number,
): ReconcileDay[] {
  const today = Math.floor(now / DAY) * DAY;
  const keys = new Map<string, { provider: "openai" | "anthropic"; day: number }>();
  for (const r of [...fuse, ...reports])
    if (r.provider === "openai" || r.provider === "anthropic")
      keys.set(`${r.provider}|${String(r.day)}`, { provider: r.provider, day: r.day });
  const out: ReconcileDay[] = [];
  for (const { provider, day } of keys.values()) {
    const fuseMicro = fuse
      .filter((f) => f.provider === provider && f.day === day)
      .reduce((n, f) => n + f.micro, 0);
    // API collection wins over a CSV import for the same day; never add the two.
    const forDay = reports.filter((r) => r.provider === provider && r.day === day);
    const source = forDay.some((r) => r.source === "api")
      ? "api"
      : forDay.length > 0
        ? "csv"
        : null;
    const reportedMicro =
      source === null
        ? null
        : forDay.filter((r) => r.source === source).reduce((n, r) => n + r.micro, 0);
    const diffMicro = reportedMicro === null ? null : reportedMicro - fuseMicro;
    const refreshed = refreshedAt[provider];
    const incomplete = day >= today || (refreshed !== undefined && day + DAY > refreshed);
    let status: ReconcileStatus;
    if (reportedMicro === null || diffMicro === null) status = incomplete ? "lagging" : "no_report";
    else if (
      Math.abs(diffMicro) <=
      Math.max(TOLERANCE_MICRO, TOLERANCE_SHARE * Math.max(fuseMicro, reportedMicro))
    )
      status = "match";
    else if (incomplete) status = "lagging";
    else status = diffMicro > 0 ? "provider_higher" : "fuse_higher";
    out.push({ provider, day, fuseMicro, reportedMicro, diffMicro, status, source });
  }
  return out.sort((a, b) => b.day - a.day || a.provider.localeCompare(b.provider));
}

/** The comparison for the last `days` UTC days, from the local database. */
export async function reconcileView(
  db: SqlDb,
  t: Tenant,
  now: number,
  days = 30,
): Promise<ReconcileView> {
  const from = Math.floor(now / DAY) * DAY - (days - 1) * DAY;
  const scopeRows = await db.select<{ key: string; value: string }>(
    `SELECT key,value FROM settings WHERE workspace_id=? AND user_id=? AND key IN
       ('usage_report.openai.scope','usage_report.anthropic.scope')`,
    [t.workspaceId, t.userId],
  );
  const scopes: ReconcileView["scopes"] = {};
  for (const r of scopeRows) {
    const list = r.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length) scopes[r.key.includes("openai") ? "openai" : "anthropic"] = list;
  }
  const fuse = await db.select<{ provider: string; day: number; micro: number }>(
    `SELECT provider,(created_at/86400000)*86400000 AS day,SUM(cost_micro_usd) AS micro
     FROM request_log WHERE workspace_id=? AND created_at>=? AND provider IN ('openai','anthropic')
     GROUP BY provider,day`,
    [t.workspaceId, from],
  );
  const rows = await db.select<{
    provider: string;
    day: number;
    source: "api" | "csv";
    currency: string;
    scope: string;
    key_ref: string;
    micro: number;
  }>(
    `SELECT provider,(bucket_start/86400000)*86400000 AS day,source,currency,scope,key_ref,
       SUM(COALESCE(amount_micro,0)) AS micro
     FROM usage_report_rows WHERE workspace_id=? AND user_id=? AND kind='cost' AND bucket_start>=?
     GROUP BY provider,day,source,currency,scope,key_ref`,
    [t.workspaceId, t.userId, from],
  );
  let otherCurrencyRows = 0;
  const reports: ReportDay[] = [];
  for (const r of rows) {
    if (r.currency !== "usd") {
      otherCurrencyRows++;
      continue;
    }
    const allowed = scopes[r.provider as "openai" | "anthropic"];
    if (allowed && !allowed.includes(r.scope) && !allowed.includes(r.key_ref)) continue;
    reports.push({ provider: r.provider, day: r.day, source: r.source, micro: r.micro });
  }
  const refreshedRows = await db.select<{ provider: "openai" | "anthropic"; at: number | null }>(
    `SELECT provider,MAX(refreshed_at) AS at FROM usage_report_runs
     WHERE workspace_id=? AND user_id=? AND state='ok' AND source='api' GROUP BY provider`,
    [t.workspaceId, t.userId],
  );
  const refreshedAt: ReconcileView["refreshedAt"] = {};
  for (const r of refreshedRows) if (r.at !== null) refreshedAt[r.provider] = r.at;
  return {
    days: reconcile(fuse, reports, refreshedAt, now),
    otherCurrencyRows,
    refreshedAt,
    scopes,
  };
}
