import type { Usage } from "@/storage/usage";
import type { ModelPrice } from "@/catalog/catalog";

const MICRO_PER_DOLLAR = 1_000_000;
const TOKENS_PER_PRICE_UNIT = 1_000_000; // prices are per 1M tokens

/** Converts a $/MTok price to integer micro-dollars per MTok (e.g. $3.00 → 3_000_000). */
export function priceToMicro(dollarsPerMTok: number): number {
  return Math.round(dollarsPerMTok * MICRO_PER_DOLLAR);
}

/**
 * Cost of one request in integer micro-dollars.
 *
 * Expects usage normalised by the adapter (see `Usage` in storage/usage.ts):
 * `inputTokens` are uncached input billed at the base rate; cache reads and cache writes are
 * separate; `outputTokens` already include reasoning tokens (`reasoningTokens` is informational).
 *
 * Exact integer arithmetic, rounded once at the end (half up), so per-message costs add up.
 */
export function cost(usage: Usage, price: ModelPrice): number {
  const parts: [number, number][] = [
    [usage.inputTokens, priceToMicro(price.input)],
    [usage.cachedInputTokens, priceToMicro(price.cachedInput ?? price.input)],
    [usage.cacheWriteTokens, priceToMicro(price.cacheWrite ?? price.input)],
    [usage.outputTokens, priceToMicro(price.output)],
  ];
  let scaled = 0; // micro-dollars × 1M
  for (const [tokens, microPerMTok] of parts) {
    if (!Number.isInteger(tokens) || tokens < 0) {
      throw new Error(`Token counts must be non-negative integers, got ${String(tokens)}`);
    }
    scaled += tokens * microPerMTok;
  }
  if (!Number.isSafeInteger(scaled)) throw new Error("Cost overflow");
  return Math.floor((scaled + TOKENS_PER_PRICE_UNIT / 2) / TOKENS_PER_PRICE_UNIT);
}

/** "$0.0093" style display, from integer micro-dollars (no float rounding).
 * Under $1: up to 4 decimals, trailing zeros trimmed to 2. From $1: 2 decimals. */
export function formatUsd(micro: number): string {
  const sign = micro < 0 ? "-" : "";
  const abs = Math.abs(micro);
  if (abs === 0) return "$0.00";
  if (abs >= MICRO_PER_DOLLAR) {
    const cents = Math.round(abs / 10_000);
    return `${sign}$${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, "0")}`;
  }
  const units = Math.round(abs / 100); // $0.0001 units
  if (units === 0) return `${sign}<$0.0001`;
  if (units === 10_000) return `${sign}$1.00`;
  const decimals = String(units)
    .padStart(4, "0")
    .replace(/0{1,2}$/, "");
  return `${sign}$0.${decimals}`;
}
