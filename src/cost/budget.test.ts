// @vitest-environment node
import type { Budget } from "@/storage/budgets";
import { alertLevel, budgetState, isAnomaly, periodEnd, periodStart, sendGate } from "./budget";

const now = new Date(2026, 9, 28, 15, 30).getTime();
const budget = (extra: Partial<Budget> = {}): Budget => ({
  id: "b",
  projectId: null,
  period: "month",
  limitMicro: 10_000_000,
  hardStop: false,
  allowUntil: null,
  ...extra,
});

test("periods start at local midnight or the 1st, and end at the next one", () => {
  expect(periodStart("day", now)).toBe(new Date(2026, 9, 28).getTime());
  expect(periodStart("month", now)).toBe(new Date(2026, 9, 1).getTime());
  expect(periodEnd("day", now)).toBe(new Date(2026, 9, 29).getTime());
  expect(periodEnd("month", now)).toBe(new Date(2026, 10, 1).getTime());
});

test("alert levels at 50, 80 and 100%", () => {
  expect([0.49, 0.5, 0.8, 1, 2].map(alertLevel)).toEqual([null, "50", "80", "100", "100"]);
});

test("past 80% Auto drops a tier; past 100% it asks; a temporary raise lifts both", () => {
  expect(sendGate([budgetState(budget(), 5_000_000, now)])).toEqual({
    downshift: null,
    over: null,
  });
  const at85 = budgetState(budget(), 8_500_000, now);
  expect(sendGate([at85])).toEqual({ downshift: at85, over: null });
  const over = budgetState(budget({ id: "day", period: "day" }), 12_000_000, now);
  expect(sendGate([at85, over])).toEqual({ downshift: over, over });
  const allowed = budgetState(budget({ allowUntil: now + 1000 }), 12_000_000, now);
  expect(sendGate([allowed])).toEqual({ downshift: null, over: null });
});

test("anomaly: today over three times the trailing average, when there is spend to compare", () => {
  expect(isAnomaly(400, [100, 100, 100])).toBe(true);
  expect(isAnomaly(300, [100, 100, 100])).toBe(false);
  expect(isAnomaly(500, [0, 0])).toBe(false);
  expect(isAnomaly(500, [])).toBe(false);
});
