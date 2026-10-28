// @vitest-environment node
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { cacheSavings } from "./savings";

test("cache savings: cheaper reads minus the write premium, per model", () => {
  // Sonnet 5.5: input $2, cached $0.10, write $2.50 per MTok.
  // 1M cached reads save $1.90; 100k written cost $0.05 extra: $1.85 net.
  expect(
    cacheSavings(defaultCatalog, [
      { provider: "anthropic", model: "claude-sonnet-5-5", cached: 1_000_000, written: 100_000 },
      { provider: "anthropic", model: "retired-model", cached: 5_000_000, written: 0 },
    ]),
  ).toBe(1_850_000);
});
