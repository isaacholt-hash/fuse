/**
 * AG-05's cost cap per run, and turning it off. A run with no cap stores a cap so large it is
 * never reached, so the run's own pause check and the request reservations (which compare spend
 * with the cap in SQL) need no special case.
 */

/** AG-05's default cap per run. */
export const DEFAULT_RUN_CAP_MICRO_USD = 1_000_000;
/** "No cap": about $4.5 billion, still a safe integer after a $1 raise. */
export const NO_RUN_CAP_MICRO_USD = 2 ** 52;
/** FUSE's own default cap for new runs: micro-dollars, or "off". */
export const RUN_CAP_SETTING = "runs.default_cap";
/** A run is warned about at this share of its cap. */
export const NEAR_CAP_SHARE = 0.8;

export const isUncapped = (capMicroUsd: number) => capMicroUsd >= NO_RUN_CAP_MICRO_USD;

/** Spent at least 80% of a real cap, and not yet at it. */
export const nearCap = (spentMicroUsd: number, capMicroUsd: number) =>
  !isUncapped(capMicroUsd) &&
  spentMicroUsd >= capMicroUsd * NEAR_CAP_SHARE &&
  spentMicroUsd < capMicroUsd;

/** The saved default: "off" is no cap; anything unreadable is AG-05's $1. */
export function parseDefaultRunCap(raw: string | null): number {
  if (raw === "off") return NO_RUN_CAP_MICRO_USD;
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0
    ? Math.min(n, NO_RUN_CAP_MICRO_USD)
    : DEFAULT_RUN_CAP_MICRO_USD;
}

export const formatDefaultRunCap = (capMicroUsd: number) =>
  isUncapped(capMicroUsd) ? "off" : String(capMicroUsd);
