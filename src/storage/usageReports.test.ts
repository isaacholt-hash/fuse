// @vitest-environment node
import { DEFAULT_TENANT as t } from "./defaults";
import { logRequest } from "./requestLog";
import { EMPTY_USAGE } from "./usage";
import { openTestDb } from "./testing/nodeDb";
import {
  amountToMicro,
  exportUsageCsv,
  importUsageCsv,
  latestRuns,
  parseCsv,
} from "./usageReports";

const HEADER =
  "source,date_utc,provider,kind,scope,key_id,model,line_item,currency,amount,input_tokens,output_tokens,cached_tokens,requests";

test("amounts are exact decimal dollars; CSV fields keep quotes, commas and newlines", () => {
  expect(amountToMicro("1.5")).toBe(1_500_000);
  expect(amountToMicro("0.0000005")).toBe(1);
  expect(amountToMicro("-2")).toBe(-2_000_000);
  for (const bad of ["1e3", "$5", "1,5", "", "abc"]) expect(amountToMicro(bad)).toBeNull();
  expect(parseCsv('a,"b,c","d ""q"""\r\n"line\nbreak",2\n\n')).toEqual([
    ["a", "b,c", 'd "q"'],
    ["line\nbreak", "2"],
  ]);
  expect(() => parseCsv('"open')).toThrow("unclosed quote");
});

test("CSV import stores report rows, replaces on re-import and refuses bad files whole", async () => {
  const db = openTestDb();
  const file = [
    HEADER,
    'csv,2026-11-05,openai,cost,proj_1,,,"gpt-6-astra, input_tokens",usd,1.250000,,,,',
    "csv,2026-11-05,anthropic,usage,wrkspc_1,,claude-sonnet-5-5,,usd,,1000,200,400,3",
    "fuse,2026-11-05,openai,request,,,gpt-6-luna,,usd,0.010000,10,5,0,1",
  ].join("\n");
  expect(await importUsageCsv(db, t, file)).toBe(2);
  const rows = await db.select<{
    provider: string;
    amount_micro: number | null;
    line_item: string;
  }>("SELECT provider,amount_micro,line_item FROM usage_report_rows ORDER BY provider");
  expect(rows).toEqual([
    { provider: "anthropic", amount_micro: null, line_item: "" },
    { provider: "openai", amount_micro: 1_250_000, line_item: "gpt-6-astra, input_tokens" },
  ]);
  // A corrected export for the same day and scope replaces the earlier value.
  await importUsageCsv(
    db,
    t,
    `${HEADER}\ncsv,2026-11-05,openai,cost,proj_1,,,"gpt-6-astra, input_tokens",usd,1.300000,,,,`,
  );
  expect(
    await db.select("SELECT amount_micro FROM usage_report_rows WHERE provider='openai'"),
  ).toEqual([{ amount_micro: 1_300_000 }]);
  expect((await latestRuns(db, t)).map((r) => [r.provider, r.source, r.state])).toEqual([
    ["anthropic", "csv", "ok"],
    ["openai", "csv", "ok"],
  ]);

  for (const bad of [
    "provider,kind\nopenai,cost",
    `${HEADER}\ncsv,05/11/2026,openai,cost,,,,,usd,1,,,,`,
    `${HEADER}\ncsv,2026-11-05,mistral,cost,,,,,usd,1,,,,`,
    `${HEADER}\ncsv,2026-11-05,openai,cost,,,,,usd,1e3,,,,`,
    `${HEADER}\ncsv,2026-11-06,openai,usage,,,,,usd,,12.5,,,`,
  ])
    await expect(importUsageCsv(db, t, bad)).rejects.toThrow();
  expect(await db.select("SELECT COUNT(*) AS n FROM usage_report_rows")).toEqual([{ n: 2 }]);
  // Imported reports never become request_log spend.
  expect(await db.select("SELECT COUNT(*) AS n FROM request_log")).toEqual([{ n: 0 }]);
});

test("export lists FUSE's requests and report rows, guarding spreadsheet formulas", async () => {
  const db = openTestDb();
  await logRequest(db, t, {
    threadId: null,
    messageId: null,
    purpose: "chat",
    provider: "openai",
    model: "=HYPERLINK(1)",
    attempt: 1,
    usage: {
      ...EMPTY_USAGE,
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 2,
      costMicroUsd: 12_345,
    },
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
    providerRequestId: null,
  });
  await importUsageCsv(
    db,
    t,
    `${HEADER}\ncsv,2026-11-05,anthropic,cost,wrkspc_1,,claude-sonnet-5-5,,usd,2.5,,,,`,
  );
  const csv = await exportUsageCsv(db, t);
  const [head, ...lines] = parseCsv(csv);
  expect(head?.join(",")).toBe(HEADER);
  const fuse = lines.find((l) => l[0] === "fuse");
  expect(fuse?.[6]).toBe("'=HYPERLINK(1)");
  expect(fuse?.[9]).toBe("0.012345");
  expect(lines.find((l) => l[0] === "csv")?.[9]).toBe("2.500000");
  // What FUSE exports, FUSE can import (its own request lines are skipped).
  expect(await importUsageCsv(openTestDb(), t, csv)).toBe(1);
});
