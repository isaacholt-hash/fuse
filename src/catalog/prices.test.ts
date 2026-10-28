// @vitest-environment node
import { parseCatalog, type Catalog } from "./catalog";
import { applyEdits, baseCatalog, diffPrices, oldestPriceDays, parseEdits } from "./prices";

const model = (id: string, input: number, verified = "2026-10-01") => ({
  provider: "openai",
  id,
  display_name: id.toUpperCase(),
  context_window: 1000,
  max_output: 100,
  price: { input, output: input * 4 },
  capabilities: ["streaming"],
  verified_on: verified,
  source_url: "https://example.com/pricing",
});
const raw = (version: string, models: unknown[]) => ({ price_version: version, models });
const shipped: Catalog = parseCatalog(raw("2026-10-01", [model("a", 1), model("b", 2)]));

test("a fetched list replaces the shipped one only when it parses and is newer", () => {
  const newer = JSON.stringify(raw("2026-11-01", [model("a", 1.5)]));
  expect(baseCatalog(shipped, newer).priceVersion).toBe("2026-11-01");
  expect(baseCatalog(shipped, JSON.stringify(raw("2026-09-01", [model("a", 9)])))).toBe(shipped);
  expect(baseCatalog(shipped, "{not json")).toBe(shipped);
  expect(baseCatalog(shipped, null)).toBe(shipped);
});

test("edits change the price, count as verified that day, and mark the price version", () => {
  const edits = parseEdits(
    JSON.stringify({ "openai/a": { input: 3, output: 6, editedOn: "2026-10-20" } }),
  );
  const out = applyEdits(shipped, edits);
  expect(out.models[0]).toMatchObject({ price: { input: 3, output: 6 }, verifiedOn: "2026-10-20" });
  expect(out.models[1]).toBe(shipped.models[1]);
  expect(out.priceVersion).toBe("2026-10-01+edits-2026-10-20");
  expect(applyEdits(shipped, parseEdits("oops"))).toBe(shipped);
});

test("age comes from the oldest price; the diff names what changed", () => {
  expect(oldestPriceDays(shipped, Date.parse("2026-11-05T12:00:00Z"))).toBe(35);
  const next = parseCatalog(raw("2026-11-01", [model("a", 1.5), model("c", 1)]));
  expect(diffPrices(shipped, next)).toEqual([
    { name: "A", change: "input $1 → $1.5, output $4 → $6" },
    { name: "C", change: "new model" },
    { name: "B", change: "removed" },
  ]);
});
