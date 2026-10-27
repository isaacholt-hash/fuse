import { EMPTY_USAGE, type Usage } from "@/storage/usage";
import { cost, formatUsd, priceToMicro } from "./cost";

const u = (p: Partial<Usage>): Usage => ({ ...EMPTY_USAGE, ...p });
// Placeholder prices for arithmetic only; real prices live in data/models.json.
const PRICE = { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 };

describe("cost", () => {
  test("hand calculation: 1,000 in + 500 out at $3/$15 per MTok = $0.0105", () => {
    // 1000 × $3/1M = $0.003; 500 × $15/1M = $0.0075; total $0.0105 = 10,500 µ$
    expect(cost(u({ inputTokens: 1000, outputTokens: 500 }), PRICE)).toBe(10_500);
  });

  test("cache reads and writes use their own rates", () => {
    // 10,000 cached × $0.30 = $0.003; 2,000 written × $3.75 = $0.0075
    expect(cost(u({ cachedInputTokens: 10_000, cacheWriteTokens: 2_000 }), PRICE)).toBe(10_500);
  });

  test("reasoning tokens are informational (already inside outputTokens)", () => {
    const withReasoning = u({ outputTokens: 1000, reasoningTokens: 800 });
    expect(cost(withReasoning, PRICE)).toBe(cost(u({ outputTokens: 1000 }), PRICE));
  });

  test("missing cache prices fall back to the input price", () => {
    expect(cost(u({ cachedInputTokens: 1000 }), { input: 2, output: 8 })).toBe(2000);
  });

  test("rounds once, half up, in micro-dollars", () => {
    // 1 token at $0.10/MTok = 0.1 µ$ → 0; 5 tokens = 0.5 µ$ → 1
    expect(cost(u({ inputTokens: 1 }), { input: 0.1, output: 0 })).toBe(0);
    expect(cost(u({ inputTokens: 5 }), { input: 0.1, output: 0 })).toBe(1);
  });

  test("float prices don't leak float error", () => {
    expect(priceToMicro(0.3)).toBe(300_000);
    expect(priceToMicro(1.1)).toBe(1_100_000);
    expect(cost(u({ inputTokens: 3 }), { input: 0.1, output: 0 })).toBe(0); // 0.3 µ$
    expect(cost(u({ inputTokens: 1_000_000 }), { input: 0.1, output: 0 })).toBe(100_000);
  });

  test("a full 1M-token context at a high price stays exact", () => {
    expect(
      cost(u({ inputTokens: 1_000_000, outputTokens: 128_000 }), { input: 10, output: 50 }),
    ).toBe(16_400_000);
  });

  test("rejects negative or fractional token counts", () => {
    expect(() => cost(u({ inputTokens: -1 }), PRICE)).toThrow();
    expect(() => cost(u({ outputTokens: 1.5 }), PRICE)).toThrow();
  });
});

test("formatUsd keeps small amounts readable", () => {
  expect(formatUsd(0)).toBe("$0.00");
  expect(formatUsd(10_500)).toBe("$0.0105");
  expect(formatUsd(93)).toBe("$0.0001");
  expect(formatUsd(412_000)).toBe("$0.412");
  expect(formatUsd(16_400_000)).toBe("$16.40");
  expect(formatUsd(40)).toBe("<$0.0001");
  expect(formatUsd(41_200)).toBe("$0.0412");
  expect(formatUsd(100_000)).toBe("$0.10");
  expect(formatUsd(999_990)).toBe("$1.00");
});
