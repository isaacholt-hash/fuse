import { cost } from "@/cost/cost";
import { EMPTY_USAGE } from "@/storage/usage";
import { priceFor } from "./catalog";
import { defaultCatalog } from "./defaultCatalog";

const OFFICIAL = /^https:\/\/(platform\.claude\.com|developers\.openai\.com)\//;

test("the shipped catalog is valid and sourced from official pages", () => {
  expect(defaultCatalog.models.length).toBeGreaterThanOrEqual(2);
  for (const m of defaultCatalog.models) {
    expect(m.sourceUrl, m.id).toMatch(OFFICIAL);
    expect(m.price.cachedInput, m.id).toBeDefined();
    expect(m.price.cacheWrite, m.id).toBeDefined();
  }
  const providers = new Set(defaultCatalog.models.map((m) => m.provider));
  expect(providers).toEqual(new Set(["openai", "anthropic"]));
});

test("hand check: Sonnet 5.5, 1,200 in + 400 out = $0.0064", () => {
  const sonnet = defaultCatalog.models.find((m) => m.id === "claude-sonnet-5-5");
  if (!sonnet) throw new Error("missing");
  // 1,200 × $2/1M = $0.0024; 400 × $10/1M = $0.0040
  const usage = { ...EMPTY_USAGE, inputTokens: 1200, outputTokens: 400 };
  expect(cost(usage, priceFor(sonnet, 1200))).toBe(6_400);
});

test("Haiku 5.5 crosses its 100k price cliff", () => {
  const haiku = defaultCatalog.models.find((m) => m.id === "claude-haiku-5-5");
  if (!haiku) throw new Error("missing");
  expect(priceFor(haiku, 100_000).input).toBe(0.1);
  expect(priceFor(haiku, 100_001).input).toBe(0.5);
});
