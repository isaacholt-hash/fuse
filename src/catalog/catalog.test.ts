import { findModel, oldestPriceAgeDays, parseCatalog, priceFor, toolPrice } from "./catalog";
import { defaultCatalog } from "./defaultCatalog";

const model = (over: Record<string, unknown> = {}) => ({
  provider: "anthropic",
  id: "test-model",
  display_name: "Test Model",
  context_window: 200_000,
  max_output: 64_000,
  price: { input: 3, output: 15, cached_input: 0.3, cache_write: 3.75 },
  capabilities: ["vision", "streaming"],
  verified_on: "2026-10-26",
  source_url: "https://example.com/pricing",
  ...over,
});
const catalog = (models: unknown[]) => ({ price_version: "2026-10-26", models });

test("parses snake_case JSON into a typed catalog", () => {
  const c = parseCatalog(catalog([model()]));
  expect(c.priceVersion).toBe("2026-10-26");
  expect(c.models[0]).toMatchObject({
    displayName: "Test Model",
    contextWindow: 200_000,
    price: { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
  });
  expect(findModel(c, "anthropic", "test-model")?.id).toBe("test-model");
  expect(findModel(c, "openai", "test-model")).toBeUndefined();
});

test.each([
  ["missing verified_on", { verified_on: undefined }, /verified_on/],
  ["bad date", { verified_on: "26/10/2026" }, /verified_on/],
  ["http source", { source_url: "http://example.com" }, /source_url/],
  ["unknown provider", { provider: "acme" }, /provider/],
  ["negative price", { price: { input: -1, output: 1 } }, /price.input/],
  ["unknown capability", { capabilities: ["telepathy"] }, /capabilities/],
])("rejects %s", (_name, over, error) => {
  expect(() => parseCatalog(catalog([model(over)]))).toThrow(error);
});

test("rejects duplicate models", () => {
  expect(() => parseCatalog(catalog([model(), model()]))).toThrow(/duplicate/);
});

test("long-context pricing applies only above the threshold", () => {
  const c = parseCatalog(
    catalog([
      model({ long_context_price: { input: 6, output: 22.5, above_input_tokens: 200_000 } }),
    ]),
  );
  const m = c.models[0];
  if (!m) throw new Error("no model");
  expect(priceFor(m, 200_000).input).toBe(3);
  expect(priceFor(m, 200_001).input).toBe(6);
});

test("price age is measured from the oldest verified_on", () => {
  const c = parseCatalog(catalog([model(), model({ id: "old", verified_on: "2026-09-01" })]));
  expect(oldestPriceAgeDays(c, new Date("2026-10-26T12:00:00Z"))).toBe(55);
});

test("tool prices: per-call fees with a source, looked up by provider and tool", () => {
  const c = parseCatalog({
    ...catalog([model()]),
    tool_prices: [
      {
        provider: "openai",
        tool: "web_search",
        usd_per_call: 0.01,
        verified_on: "2026-10-27",
        source_url: "https://example.com/pricing",
      },
    ],
  });
  expect(toolPrice(c, "openai", "web_search")?.usdPerCall).toBe(0.01);
  expect(toolPrice(c, "anthropic", "web_search")).toBeUndefined();
  expect(parseCatalog(catalog([model()])).toolPrices).toEqual([]); // optional
  expect(() =>
    parseCatalog({
      ...catalog([model()]),
      tool_prices: [
        {
          provider: "openai",
          tool: "teleport",
          usd_per_call: 1,
          verified_on: "2026-10-27",
          source_url: "https://x",
        },
      ],
    }),
  ).toThrow(/unknown tool/);
});

test("the shipped catalog prices web search for both providers", () => {
  for (const p of ["anthropic", "openai"] as const) {
    expect(toolPrice(defaultCatalog, p, "web_search")?.usdPerCall).toBeGreaterThan(0);
  }
});

test("embedding models: optional, priced per input token, with a source", () => {
  expect(parseCatalog(catalog([model()])).embeddingModels).toEqual([]);
  const small = defaultCatalog.embeddingModels.find((e) => e.id === "text-embedding-3-small");
  expect(small).toMatchObject({ provider: "openai", dimensions: 1536, inputPrice: 0.02 });
  expect(() =>
    parseCatalog({
      ...catalog([model()]),
      embedding_models: [
        {
          provider: "openai",
          id: "e",
          dimensions: 8,
          max_input_tokens: 10,
          input_price: 1,
          verified_on: "2026-10-28",
          source_url: "http://insecure",
        },
      ],
    }),
  ).toThrow(/https/);
});
