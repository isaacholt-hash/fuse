// @vitest-environment node
// AG-05: a run's cost cap can be turned off, and a run is warned about near it.
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createRun, getRun, raiseRunCap } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import {
  DEFAULT_RUN_CAP_MICRO_USD,
  formatDefaultRunCap,
  isUncapped,
  nearCap,
  NO_RUN_CAP_MICRO_USD,
  parseDefaultRunCap,
} from "./runCap";

test("the saved default reads back, with off as no cap and junk as $1", () => {
  expect(parseDefaultRunCap(null)).toBe(DEFAULT_RUN_CAP_MICRO_USD);
  expect(parseDefaultRunCap("off")).toBe(NO_RUN_CAP_MICRO_USD);
  expect(parseDefaultRunCap("2500000")).toBe(2_500_000);
  expect(parseDefaultRunCap("-3")).toBe(DEFAULT_RUN_CAP_MICRO_USD);
  expect(parseDefaultRunCap("1.5")).toBe(DEFAULT_RUN_CAP_MICRO_USD);
  expect(formatDefaultRunCap(NO_RUN_CAP_MICRO_USD)).toBe("off");
  expect(parseDefaultRunCap(formatDefaultRunCap(3_000_000))).toBe(3_000_000);
});

test("near the cap from 80% until it is reached, never with no cap", () => {
  expect(nearCap(790_000, 1_000_000)).toBe(false);
  expect(nearCap(800_000, 1_000_000)).toBe(true);
  expect(nearCap(1_000_000, 1_000_000)).toBe(false);
  expect(nearCap(NO_RUN_CAP_MICRO_USD - 1, NO_RUN_CAP_MICRO_USD)).toBe(false);
});

test("taking the cap off a run stops at no cap and stays a safe integer", async () => {
  const db = openTestDb();
  const run = await createRun(db, DEFAULT_TENANT, {
    projectId: null,
    threadId: null,
    messageId: null,
    task: "t",
    provider: "anthropic",
    model: "m",
    capMicroUsd: 1_000_000,
  });
  await raiseRunCap(db, DEFAULT_TENANT, run.id, NO_RUN_CAP_MICRO_USD);
  const off = await getRun(db, DEFAULT_TENANT, run.id);
  expect(off?.capMicroUsd).toBe(NO_RUN_CAP_MICRO_USD);
  // A later "+$1" on a run with no cap leaves it there.
  await raiseRunCap(db, DEFAULT_TENANT, run.id, DEFAULT_RUN_CAP_MICRO_USD);
  const again = await getRun(db, DEFAULT_TENANT, run.id);
  expect(again?.capMicroUsd).toBe(NO_RUN_CAP_MICRO_USD);
  expect(isUncapped(again?.capMicroUsd ?? 0)).toBe(true);
});
