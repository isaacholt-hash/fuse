// @vitest-environment node
import { modelDefaultsKey, projectKey, resolveDefaults, tierKey } from "./modelDefaults";

test("project beats model beats tier, field by field", () => {
  const all = {
    [tierKey("balanced")]: { maxOutputTokens: 2000, effort: "low" as const, prefix: "Be brief." },
    [modelDefaultsKey("anthropic", "s")]: { effort: "high" as const },
    [projectKey("p1")]: { prefix: "Use British spelling." },
  };
  expect(
    resolveDefaults(all, { provider: "anthropic", id: "s", tier: "balanced", projectId: "p1" }),
  ).toEqual({ maxOutputTokens: 2000, effort: "high", prefix: "Use British spelling." });
  expect(
    resolveDefaults(all, { provider: "openai", id: "o", tier: "best", projectId: null }),
  ).toEqual({});
});
