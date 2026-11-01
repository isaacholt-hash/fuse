// @vitest-environment node
import type { UsageRecord } from "@/storage/usageReport";
import { usageReport } from "./report";

const now = new Date(2026, 9, 28, 15, 0).getTime();
const at = (daysAgo: number, hour = 12) => new Date(2026, 9, 28 - daysAgo, hour).getTime();
const row = (
  daysAgo: number,
  costMicro: number,
  extra: Partial<UsageRecord> = {},
): UsageRecord => ({
  at: at(daysAgo),
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  tier: "balanced",
  purpose: "chat",
  projectId: null,
  intent: "chat",
  area: "chat",
  surface: "desktop",
  costMicro,
  ...extra,
});

const rows = [
  row(0, 1000),
  row(0, 3000, {
    provider: "openai",
    model: "gpt-6-astra",
    tier: "best",
    intent: "coding",
    projectId: "p1",
  }),
  row(0, 50, {
    purpose: "title",
    tier: null,
    intent: null,
    provider: "openai",
    model: "gpt-6-luna",
  }),
  row(1, 2000),
  row(6, 500),
  row(7, 700),
  row(13, 100),
  row(40, 9999),
];

test("today against yesterday, by hour", () => {
  const r = usageReport(rows, "day", now);
  expect([r.current, r.previous, r.calls]).toEqual([4050, 2000, 3]);
  expect(r.buckets).toHaveLength(24);
  expect(r.buckets[12]?.micro).toBe(4050);
});

test("seven days against the seven before, by day, grouped every way", () => {
  const r = usageReport(rows, "week", now);
  expect([r.current, r.previous]).toEqual([6550, 800]);
  expect(r.buckets.map((b) => b.micro)).toEqual([500, 0, 0, 0, 0, 2000, 4050]);
  expect(r.groups.provider).toEqual([
    { key: "anthropic", micro: 3500, calls: 3 },
    { key: "openai", micro: 3050, calls: 2 },
  ]);
  expect(r.groups.tier.map((g) => g.key)).toEqual(["balanced", "best", ""]);
  expect(r.groups.project.map((g) => [g.key, g.micro])).toEqual([
    ["", 3550],
    ["p1", 3000],
  ]);
  expect(r.groups.purpose.map((g) => g.key)).toEqual(["chat", "title"]);
});

test("thirty days leaves out older calls", () => {
  const r = usageReport(rows, "month", now);
  expect(r.current).toBe(7350);
  expect(r.previous).toBe(9999);
});

test("M10 step 17: spend by area and by where it ran", () => {
  const r = usageReport(
    [
      row(0, 1000),
      row(0, 4000, { area: "code", surface: "runner" }),
      row(0, 2000, { area: "code", surface: "scheduled" }),
      row(0, 500, { area: null, surface: null }),
    ],
    "day",
    now,
  );
  expect(r.groups.area.map((g) => [g.key, g.micro])).toEqual([
    ["code", 6000],
    ["chat", 1000],
    ["", 500],
  ]);
  expect(r.groups.surface.map((g) => g.key)).toEqual(["runner", "scheduled", "desktop", ""]);
});
