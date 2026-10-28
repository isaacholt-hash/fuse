/** The usage dashboard's numbers (CO-02): spend in a period against the one before, and where it went. */
import type { UsageRecord } from "@/storage/usageReport";

export type Period = "day" | "week" | "month";

const DAY_MS = 86_400_000;
/** Days in each period, ending today (local time). */
export const PERIOD_DAYS: Record<Period, number> = { day: 1, week: 7, month: 30 };

export interface Bucket {
  /** Start of the bucket (local midnight, or the hour for "day"). */
  start: number;
  micro: number;
}

export interface Group {
  key: string;
  micro: number;
  calls: number;
}

export type Dimension = "provider" | "model" | "tier" | "project" | "intent" | "purpose";

export interface UsageReport {
  from: number;
  to: number;
  current: number;
  previous: number;
  calls: number;
  /** Hours for a day, days otherwise. */
  buckets: Bucket[];
  groups: Record<Dimension, Group[]>;
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Adds days in local time, so a daylight-saving change doesn't shift midnight. */
const addDays = (ms: number, days: number) => {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
};

const keyOf: Record<Dimension, (r: UsageRecord) => string | null> = {
  provider: (r) => r.provider,
  model: (r) => `${r.provider}/${r.model}`,
  tier: (r) => r.tier,
  project: (r) => r.projectId,
  intent: (r) => r.intent,
  purpose: (r) => r.purpose,
};

function groupBy(rows: readonly UsageRecord[], dim: Dimension): Group[] {
  const out = new Map<string, Group>();
  for (const r of rows) {
    // Calls without the attribute (housekeeping has no tier, loose chats no project) group as "".
    const key = keyOf[dim](r) ?? "";
    const g = out.get(key) ?? { key, micro: 0, calls: 0 };
    g.micro += r.costMicro;
    g.calls += 1;
    out.set(key, g);
  }
  return [...out.values()].sort((a, b) => b.micro - a.micro || b.calls - a.calls);
}

/** `rows` should cover at least two periods back from `now`. */
export function usageReport(
  rows: readonly UsageRecord[],
  period: Period,
  now: number,
): UsageReport {
  const days = PERIOD_DAYS[period];
  const to = addDays(startOfDay(now), 1);
  const from = addDays(to, -days);
  const prevFrom = addDays(from, -days);
  const inPeriod = rows.filter((r) => r.at >= from && r.at < to);
  const sum = (list: readonly UsageRecord[]) => list.reduce((s, r) => s + r.costMicro, 0);
  const buckets: Bucket[] =
    period === "day"
      ? Array.from({ length: 24 }, (_, h) => ({ start: from + h * 3_600_000, micro: 0 }))
      : Array.from({ length: days }, (_, i) => ({ start: addDays(from, i), micro: 0 }));
  for (const r of inPeriod) {
    const i =
      period === "day"
        ? Math.floor((r.at - from) / 3_600_000)
        : Math.floor((startOfDay(r.at) - from) / DAY_MS + 0.5);
    const b = buckets[Math.min(buckets.length - 1, Math.max(0, i))];
    if (b) b.micro += r.costMicro;
  }
  const dims: Dimension[] = ["provider", "model", "tier", "project", "intent", "purpose"];
  return {
    from,
    to,
    current: sum(inPeriod),
    previous: sum(rows.filter((r) => r.at >= prevFrom && r.at < from)),
    calls: inPeriod.length,
    buckets,
    groups: Object.fromEntries(dims.map((d) => [d, groupBy(inPeriod, d)])) as Record<
      Dimension,
      Group[]
    >,
  };
}
