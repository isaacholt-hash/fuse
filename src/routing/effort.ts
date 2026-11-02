// M10 step 22 (RT-08): the effort dial. Which levels a model offers, its own default, and what
// a level is likely to add to a message's cost (typical reasoning tokens at the output rate;
// data/effort.json). The real count comes back with the answer.
import raw from "../../data/effort.json";
import type { CatalogModel, EffortLevel } from "@/catalog/catalog";
import { priceToMicro } from "@/cost/cost";

export const EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function typical(): Record<EffortLevel, number> {
  const v = (raw as { typical_reasoning_tokens?: Record<string, unknown> })
    .typical_reasoning_tokens;
  const out = { low: 300, medium: 1200, high: 3000, xhigh: 6000, max: 12000 };
  for (const e of EFFORTS) {
    const n = v?.[e];
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) out[e] = n;
  }
  return out;
}

/** Reasoning tokens a typical answer spends at each level (data/effort.json). */
export const TYPICAL_REASONING_TOKENS: Record<EffortLevel, number> = typical();

/** The levels a model offers: the catalog's list, else all five. */
export function effortsOf(model: Pick<CatalogModel, "efforts">): readonly EffortLevel[] {
  return model.efforts && model.efforts.length > 0 ? model.efforts : EFFORTS;
}

/** What the model does when nobody asks: the catalog's default, else medium. */
export function defaultEffortOf(model: Pick<CatalogModel, "defaultEffort">): EffortLevel {
  return model.defaultEffort ?? "medium";
}

/**
 * What `chosen` adds to (or takes from) a message's cost compared with `baseline`, in
 * micro-dollars: the difference in typical reasoning tokens at the model's output rate.
 */
export function extraReasoningMicro(
  model: Pick<CatalogModel, "price">,
  baseline: EffortLevel,
  chosen: EffortLevel,
): number {
  const tokens = TYPICAL_REASONING_TOKENS[chosen] - TYPICAL_REASONING_TOKENS[baseline];
  return Math.round((tokens * priceToMicro(model.price.output)) / 1_000_000);
}

/** Reasoning tokens so far, guessed from streamed summary text (about four characters each). */
export const guessReasoningTokens = (summaryChars: number) => Math.ceil(summaryChars / 4);
