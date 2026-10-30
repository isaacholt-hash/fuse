// @vitest-environment node
import { answerWithoutModel, evaluate, formatNumber, MAX_INPUT } from "./handlers";

// 2026-10-30, midday local time.
const NOW = new Date(2026, 9, 30, 12, 0).getTime();
const ask = (q: string) => answerWithoutModel(q, NOW);

/** LL-01's deterministic suite: each answered exactly, with no model. */
const SUITE: [string, string, string][] = [
  ["2+2", "arithmetic", "2+2 = 4"],
  ["what is 12 * 7?", "arithmetic", "12 * 7 = 84"],
  ["calculate (3 + 4) × 2 - 1", "arithmetic", "(3 + 4) × 2 - 1 = 13"],
  ["2^10", "arithmetic", "2^10 = 1,024"],
  ["1,250.50 / 4 =", "arithmetic", "1,250.50 / 4 = 312.625"],
  ["-3 + 5 * 2", "arithmetic", "-3 + 5 * 2 = 7"],
  ["0.1 + 0.2", "arithmetic", "0.1 + 0.2 = 0.3"],
  ["what is 15% of 80?", "arithmetic", "15% of 80 = 12"],
  ["convert 5 km to miles", "units", "5 km = 3.10685596119 mi"],
  ["100 F in C", "units", "100 °F = 37.7777777778 °C"],
  ["what is 0 celsius in kelvin", "units", "0 °C = 273.15 K"],
  ["3 lb to kg", "units", "3 lb = 1.36077711 kg"],
  ["1 GiB in MB", "units", "1 GiB = 1,073.741824 MB"],
  ["90 minutes to hours", "units", "90 min = 1.5 h"],
  ["what day is 2026-12-25?", "dates", "2026-12-25 is a Friday."],
  ["what day of the week was 2000-01-01", "dates", "2000-01-01 is a Saturday."],
  [
    "how many days between 2026-01-01 and 2026-12-25",
    "dates",
    "358 days from 2026-01-01 to 2026-12-25.",
  ],
  ["days from today until 2026-12-25", "dates", "56 days from 2026-10-30 to 2026-12-25."],
  ["2026-10-30 plus 30 days", "dates", "2026-11-29 (Sunday)."],
  ["10 days before 2026-03-05", "dates", "2026-02-23 (Monday)."],
  [
    "convert 15:00 UTC to Asia/Tokyo",
    "dates",
    "15:00 UTC is 00:00 Asia/Tokyo (the next day), today.",
  ],
  [
    "9am America/New_York to Europe/London",
    "dates",
    "09:00 America/New_York is 13:00 Europe/London, today.",
  ],
  ["count the words in: the quick brown fox", "count", "4 words."],
  ['how many characters are in this: "héllo world"', "count", "11 characters (10 without spaces)."],
  ["how many lines in:\na\nb\nc", "count", "3 lines."],
  ['is this valid json: {"a": [1, 2], "b": null}', "json", "Valid JSON: an object with 2 keys."],
  ["validate this JSON:\n```json\n[1, 2, 3]\n```", "json", "Valid JSON: an array of 3 items."],
  [
    'check csv:\nname,age\nAda,36\n"Lovelace, A",37',
    "csv",
    "Valid CSV: 3 rows (header included), 2 columns.",
  ],
  ["is this valid csv:\na,b\n1,2,3", "csv", "Not valid CSV: row 2 has 3 fields, but row 1 has 2."],
];

test.each(SUITE)("%s", (question, handler, answer) => {
  expect(ask(question)).toEqual({ handler, answer });
});

test("invalid JSON says why", () => {
  const r = ask('is this valid json: {"a": }');
  expect(r?.handler).toBe("json");
  expect(r?.answer).toMatch(/^Not valid JSON: /);
});

/** Anything with more to it than the rule answers goes to a model. */
test.each([
  "what is 2+2 and why does it matter?",
  "explain 12 * 7",
  "2026-10-30",
  "555-1234",
  "1/0",
  "2026",
  "what is the capital of France?",
  "convert 5 km to kg",
  "convert 5 parsecs to miles",
  "what day is 2026-02-30",
  "3 EST to PST",
  "convert 15:00 UTC to Mars/Olympus",
  "write a function that returns 2+2",
  "",
])("not answered: %s", (question) => {
  expect(ask(question)).toBeNull();
});

test("bounded: long inputs and deep nesting go to a model", () => {
  expect(ask(`count words in: ${"a ".repeat(MAX_INPUT)}`)).toBeNull();
  expect(evaluate(`${"(".repeat(60)}1${")".repeat(60)}`)).toBeNull();
  expect(evaluate(`${"(".repeat(10)}1${")".repeat(10)}`)).toBe(1);
});

test("numbers: 12 significant digits, grouped, no -0", () => {
  expect(formatNumber(1 / 3)).toBe("0.333333333333");
  expect(formatNumber(-0)).toBe("0");
  expect(formatNumber(1e25)).toBe("1e+25");
  expect(formatNumber(1234567)).toBe("1,234,567");
});
