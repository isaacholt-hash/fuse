/** Budget arithmetic (CO-03, RT-10, CO-07): periods, levels, and the spend anomaly. Pure. */
import type { Budget, BudgetPeriod } from "@/storage/budgets";

/** Local midnight today, or the 1st of this month. */
export function periodStart(period: BudgetPeriod, now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (period === "month") d.setDate(1);
  return d.getTime();
}

/** When the current period ends (the next one starts). */
export function periodEnd(period: BudgetPeriod, now: number): number {
  const d = new Date(periodStart(period, now));
  if (period === "day") d.setDate(d.getDate() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

export interface BudgetState {
  budget: Budget;
  spent: number;
  /** spent / limit */
  used: number;
  /** A temporary raise is in force. */
  allowed: boolean;
}

export function budgetState(budget: Budget, spent: number, now: number): BudgetState {
  return {
    budget,
    spent,
    used: spent / budget.limitMicro,
    allowed: budget.allowUntil !== null && budget.allowUntil > now,
  };
}

/** The highest alert level reached (CO-03): 100, 80, 50 or none. */
export function alertLevel(used: number): "50" | "80" | "100" | null {
  return used >= 1 ? "100" : used >= 0.8 ? "80" : used >= 0.5 ? "50" : null;
}

/** What the budgets mean for the next send. */
export interface SendGate {
  /** RT-10: at 80% Auto drops one tier (never below the floor). */
  downshift: BudgetState | null;
  /** At 100% every send asks first; with a hard stop, it's refused. */
  over: BudgetState | null;
}

export function sendGate(states: readonly BudgetState[]): SendGate {
  const live = states.filter((s) => !s.allowed);
  const worst = (min: number) =>
    live.filter((s) => s.used >= min).sort((a, b) => b.used - a.used)[0] ?? null;
  return { downshift: worst(0.8), over: worst(1) };
}

/** CO-07: today's spend over three times the trailing 14-day average (when there is one). */
export function isAnomaly(today: number, previousDays: readonly number[]): boolean {
  if (previousDays.length === 0) return false;
  const average = previousDays.reduce((a, b) => a + b, 0) / previousDays.length;
  return average > 0 && today > 3 * average;
}
