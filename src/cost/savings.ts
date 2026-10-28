/** The monthly savings report (CO-04). Pure: storage supplies the sums, the catalog the prices. */
import { findModel, type Catalog } from "@/catalog/catalog";
import { priceToMicro } from "./cost";

/**
 * Net cache savings in micro-dollars: reads that cost less than fresh input, minus the premium
 * paid to write the cache. Models no longer in the catalog are skipped.
 */
export function cacheSavings(
  catalog: Catalog,
  rows: readonly { provider: string; model: string; cached: number; written: number }[],
): number {
  let scaled = 0; // micro-dollars × 1M
  for (const r of rows) {
    const provider = r.provider === "openai" || r.provider === "anthropic" ? r.provider : null;
    const m = provider ? findModel(catalog, provider, r.model) : undefined;
    if (!m) continue;
    const input = priceToMicro(m.price.input);
    scaled += r.cached * (input - priceToMicro(m.price.cachedInput ?? m.price.input));
    scaled -= r.written * (priceToMicro(m.price.cacheWrite ?? m.price.input) - input);
  }
  return Math.round(scaled / 1_000_000);
}

export interface Savings {
  spent: number;
  /** The same answers on the cheapest Best model (an estimate). */
  onBest: number;
  cache: number;
  /** What you'd pay for the subscriptions FUSE replaces; null until entered. */
  subscription: number | null;
}
