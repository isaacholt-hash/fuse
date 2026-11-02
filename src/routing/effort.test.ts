import { defaultCatalog } from "@/catalog/defaultCatalog";
import {
  EFFORTS,
  TYPICAL_REASONING_TOKENS,
  defaultEffortOf,
  effortsOf,
  extraReasoningMicro,
  guessReasoningTokens,
} from "./effort";

const sonnet = defaultCatalog.models.find((m) => m.id === "claude-sonnet-5-5");
const opus = defaultCatalog.models.find((m) => m.id === "claude-opus-5-5");
if (!sonnet || !opus) throw new Error("catalog models missing");

test("the levels and defaults come from the catalog, with sane fallbacks", () => {
  expect(effortsOf(sonnet)).toEqual(EFFORTS);
  expect(defaultEffortOf(sonnet)).toBe("high");
  expect(defaultEffortOf(opus)).toBe("medium");
  expect(effortsOf({ efforts: ["low", "high"] })).toEqual(["low", "high"]);
  expect(effortsOf({})).toEqual(EFFORTS);
  expect(defaultEffortOf({})).toBe("medium");
  // The data file's numbers climb with effort.
  expect(TYPICAL_REASONING_TOKENS.low).toBeLessThan(TYPICAL_REASONING_TOKENS.medium);
  expect(TYPICAL_REASONING_TOKENS.medium).toBeLessThan(TYPICAL_REASONING_TOKENS.max);
});

test("what a level adds is the typical reasoning difference at the output rate", () => {
  // Opus: $20 per million output tokens. Medium → max: (12000 − 1200) × $20 / 1M = $0.216.
  expect(extraReasoningMicro(opus, "medium", "max")).toBe(216_000);
  expect(extraReasoningMicro(opus, "medium", "medium")).toBe(0);
  expect(extraReasoningMicro(opus, "high", "low")).toBeLessThan(0);
  expect(guessReasoningTokens(0)).toBe(0);
  expect(guessReasoningTokens(401)).toBe(101);
});
