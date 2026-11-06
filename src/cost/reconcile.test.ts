// @vitest-environment node
import { DEFAULT_TENANT as t } from "@/storage/defaults";
import { logRequest } from "@/storage/requestLog";
import { openTestDb } from "@/storage/testing/nodeDb";
import { setSetting } from "@/storage/settings";
import { EMPTY_USAGE } from "@/storage/usage";
import { importUsageCsv } from "@/storage/usageReports";
import { reconcile, reconcileView } from "./reconcile";

const DAY = 86_400_000;
const d = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

test("days match within tolerance, explain differences, and wait for lagging reports", () => {
  const now = d("2026-11-06") + 12 * 3600_000;
  const fuse = [
    { provider: "openai", day: d("2026-11-01"), micro: 1_000_000 },
    { provider: "openai", day: d("2026-11-02"), micro: 1_000_000 },
    { provider: "openai", day: d("2026-11-03"), micro: 2_000_000 },
    { provider: "anthropic", day: d("2026-11-06"), micro: 500_000 },
    { provider: "anthropic", day: d("2026-11-04"), micro: 300_000 },
  ];
  const reports = [
    { provider: "openai", day: d("2026-11-01"), source: "api" as const, micro: 1_015_000 },
    { provider: "openai", day: d("2026-11-02"), source: "api" as const, micro: 3_000_000 },
    // A CSV import for the same day as the API report doesn't add to it.
    { provider: "openai", day: d("2026-11-02"), source: "csv" as const, micro: 9_000_000 },
    { provider: "openai", day: d("2026-11-03"), source: "csv" as const, micro: 1_000_000 },
    { provider: "anthropic", day: d("2026-11-04"), source: "api" as const, micro: 0 },
  ];
  const days = reconcile(fuse, reports, { anthropic: d("2026-11-04") + 6 * 3600_000 }, now);
  const by = (p: string, iso: string) => days.find((x) => x.provider === p && x.day === d(iso));
  expect(by("openai", "2026-11-01")?.status).toBe("match");
  expect(by("openai", "2026-11-02")).toMatchObject({
    status: "provider_higher",
    reportedMicro: 3_000_000,
    diffMicro: 2_000_000,
    source: "api",
  });
  expect(by("openai", "2026-11-03")).toMatchObject({ status: "fuse_higher", source: "csv" });
  // Anthropic's data was refreshed partway through Nov 4: not a real difference yet.
  expect(by("anthropic", "2026-11-04")?.status).toBe("lagging");
  // Today never has a final report.
  expect(by("anthropic", "2026-11-06")?.status).toBe("lagging");
  expect(days.map((x) => x.day)).toEqual([...days.map((x) => x.day)].sort((a, b) => b - a));
  expect(reconcile(fuse.slice(0, 1), [], {}, now + 30 * DAY)[0]?.status).toBe("no_report");
});

test("the database view keeps scopes and currencies apart and never changes spend", async () => {
  const db = openTestDb();
  await logRequest(db, t, {
    threadId: null,
    messageId: null,
    purpose: "chat",
    provider: "openai",
    model: "m",
    attempt: 1,
    usage: { ...EMPTY_USAGE, costMicroUsd: 1_000_000 },
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
    providerRequestId: null,
  });
  const today = new Date(Date.now()).toISOString().slice(0, 10);
  const head =
    "source,date_utc,provider,kind,scope,key_id,model,line_item,currency,amount,input_tokens,output_tokens,cached_tokens,requests";
  await importUsageCsv(
    db,
    t,
    [
      head,
      `csv,${today},openai,cost,proj_fuse,,,,usd,1.0,,,,`,
      `csv,${today},openai,cost,proj_other,,,,usd,4.0,,,,`,
      `csv,${today},openai,cost,proj_fuse,,,x,eur,9.0,,,,`,
    ].join("\n"),
  );
  const all = await reconcileView(db, t, Date.now());
  expect(all.otherCurrencyRows).toBe(1);
  expect(all.days[0]).toMatchObject({ provider: "openai", reportedMicro: 5_000_000 });
  await setSetting(db, t, "usage_report.openai.scope", "proj_fuse");
  const scoped = await reconcileView(db, t, Date.now());
  expect(scoped.scopes.openai).toEqual(["proj_fuse"]);
  expect(scoped.days[0]).toMatchObject({ fuseMicro: 1_000_000, reportedMicro: 1_000_000 });
  expect(await db.select("SELECT SUM(cost_micro_usd) AS n FROM request_log")).toEqual([
    { n: 1_000_000 },
  ]);
});
