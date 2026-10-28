import { parseCatalog } from "@/catalog/catalog";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { defaultPolicy } from "./defaultPolicy";
import {
  checkPolicy,
  chooseTier,
  floorFor,
  parsePolicy,
  tierModels,
  tierOf,
  type Task,
} from "./policy";

// Placeholder prices for ordering; real ones live in data/models.json.
const m = (provider: string, id: string, over: Record<string, unknown> = {}) => ({
  provider,
  id,
  display_name: id,
  context_window: 200_000,
  max_output: 1000,
  price: { input: 1, output: 5 },
  capabilities: ["vision"],
  verified_on: "2026-10-26",
  source_url: "https://example.com",
  ...over,
});
const catalog = parseCatalog({
  price_version: "2026-10-26",
  models: [
    m("anthropic", "a-small", {
      long_context_price: { input: 5, output: 25, above_input_tokens: 100_000 },
    }),
    m("openai", "o-small"),
    m("anthropic", "a-mid", { price: { input: 2, output: 10 } }),
    m("openai", "o-mid", { price: { input: 2, output: 10 }, capabilities: [] }),
    m("anthropic", "a-big", { price: { input: 4, output: 20 } }),
    m("openai", "o-big", { price: { input: 10, output: 50 }, context_window: 1_000_000 }),
  ],
});

const raw = (over: Record<string, unknown> = {}) => ({
  policy_version: "2026-10-28",
  built_from_price_version: "2026-10-26",
  tiers: [
    {
      id: "cheap",
      label: "Cheap",
      description: "-",
      models: ["anthropic/a-small", "openai/o-small"],
    },
    {
      id: "balanced",
      label: "Balanced",
      description: "-",
      models: ["anthropic/a-mid", "openai/o-mid"],
    },
    { id: "best", label: "Best", description: "-", models: ["anthropic/a-big", "openai/o-big"] },
  ],
  housekeeping: { title: "cheap", classify: "cheap", memory: "cheap", summary: "cheap" },
  quality_floor: {
    default: "balanced",
    overrides: [{ intents: ["reasoning"], complexities: ["high"], tier: "best" }],
  },
  provider_preference: [],
  rules: [
    { id: "big-context", when: { min_context_tokens: 500_000 }, tier: "best", reason: "Big" },
    { id: "default", when: {}, tier: "balanced", reason: "Default" },
  ],
  ...over,
});
const policy = parsePolicy(raw());
const task = (over: Partial<Task> = {}): Task => ({
  intent: "chat",
  complexity: "low",
  capabilities: [],
  contextTokens: 1000,
  ...over,
});
const ids = (models: { id: string }[]) => models.map((x) => x.id);
const both = ["anthropic", "openai"] as const;

describe("parsing", () => {
  test("parses snake_case JSON into a typed policy", () => {
    expect(policy.tiers.map((t) => t.id)).toEqual(["cheap", "balanced", "best"]);
    expect(policy.tiers[0]?.models[1]).toEqual({ provider: "openai", id: "o-small" });
    expect(policy.rules[0]?.when).toEqual({ minContextTokens: 500_000 });
    expect(policy.housekeeping.title).toBe("cheap");
  });

  test.each([
    [
      "a rule on Cheap",
      { rules: [{ id: "x", when: {}, tier: "cheap", reason: "-" }] },
      /never answers/,
    ],
    ["a Cheap floor", { quality_floor: { default: "cheap", overrides: [] } }, /never answers/],
    [
      "no catch-all rule",
      { rules: [{ id: "x", when: { intents: ["chat"] }, tier: "best", reason: "-" }] },
      /last rule/,
    ],
    [
      "duplicate rule ids",
      {
        rules: [
          { id: "x", when: {}, tier: "best", reason: "-" },
          { id: "x", when: {}, tier: "best", reason: "-" },
        ],
      },
      /duplicate rule/,
    ],
    [
      "an unknown intent",
      { rules: [{ id: "x", when: { intents: ["poetry"] }, tier: "best", reason: "-" }] },
      /intents/,
    ],
    [
      "tiers out of order",
      {
        tiers: [
          { id: "best", label: "Best", description: "-", models: [] },
          { id: "balanced", label: "Balanced", description: "-", models: [] },
          { id: "cheap", label: "Cheap", description: "-", models: [] },
        ],
      },
      /in that order/,
    ],
    [
      "a model in two tiers",
      {
        tiers: [
          { id: "cheap", label: "Cheap", description: "-", models: ["openai/o-small"] },
          { id: "balanced", label: "Balanced", description: "-", models: ["openai/o-small"] },
          { id: "best", label: "Best", description: "-", models: [] },
        ],
      },
      /more than one tier/,
    ],
    [
      "a missing housekeeping purpose",
      { housekeeping: { title: "cheap" } },
      /housekeeping.classify/,
    ],
  ])("rejects %s", (_name, over, error) => {
    expect(() => parsePolicy(raw(over))).toThrow(error);
  });

  test("checkPolicy reports models missing from the catalog and empty tiers", () => {
    const bad = parsePolicy(
      raw({
        tiers: [
          { id: "cheap", label: "Cheap", description: "-", models: ["openai/gone"] },
          { id: "balanced", label: "Balanced", description: "-", models: [] },
          { id: "best", label: "Best", description: "-", models: ["anthropic/a-big"] },
        ],
      }),
    );
    expect(checkPolicy(bad, catalog)).toEqual([
      "Cheap lists openai/gone, which isn't in the catalog",
      "The Balanced tier has no models",
    ]);
    expect(checkPolicy(policy, catalog)).toEqual([]);
  });
});

describe("choosing a tier", () => {
  test("first matching rule wins, and the floor raises it (RT-17)", () => {
    expect(chooseTier(policy, task())).toMatchObject({ tier: "balanced", raisedToFloor: false });
    expect(chooseTier(policy, task({ contextTokens: 600_000 })).rule.id).toBe("big-context");
    const hard = chooseTier(policy, task({ intent: "reasoning", complexity: "high" }));
    expect(hard).toMatchObject({ tier: "best", raisedToFloor: true });
    expect(hard.rule.id).toBe("default");
  });

  test("floors combine: the highest matching override wins", () => {
    expect(floorFor(policy, "reasoning", "high")).toBe("best");
    expect(floorFor(policy, "reasoning", "low")).toBe("balanced");
    expect(floorFor(policy, "chat", "high")).toBe("balanced");
  });
});

describe("models in a tier", () => {
  test("cheapest first; ties go to the chat's provider, then file order", () => {
    expect(ids(tierModels(policy, catalog, "best", { providers: both }))).toEqual([
      "a-big",
      "o-big",
    ]);
    expect(ids(tierModels(policy, catalog, "balanced", { providers: both }))).toEqual([
      "a-mid",
      "o-mid",
    ]);
    expect(
      ids(tierModels(policy, catalog, "balanced", { providers: both, prefer: "openai" })),
    ).toEqual(["o-mid", "a-mid"]);
  });

  test("the policy's provider preference beats the chat's provider on a tie", () => {
    const p = parsePolicy(raw({ provider_preference: ["openai"] }));
    expect(
      ids(tierModels(p, catalog, "balanced", { providers: both, prefer: "anthropic" })),
    ).toEqual(["o-mid", "a-mid"]);
  });

  test("only providers with a key, models with the needed capabilities and room for the input", () => {
    expect(ids(tierModels(policy, catalog, "balanced", { providers: ["openai"] }))).toEqual([
      "o-mid",
    ]);
    expect(
      ids(tierModels(policy, catalog, "balanced", { providers: both, needs: ["vision"] })),
    ).toEqual(["a-mid"]);
    expect(
      ids(tierModels(policy, catalog, "best", { providers: both, inputTokens: 300_000 })),
    ).toEqual(["o-big"]);
  });

  test("long-context prices change the order", () => {
    const at = (inputTokens: number) =>
      ids(tierModels(policy, catalog, "cheap", { providers: both, inputTokens }));
    expect(at(1000)).toEqual(["a-small", "o-small"]);
    expect(at(150_000)).toEqual(["o-small", "a-small"]);
  });

  test("tierOf finds a model's tier", () => {
    const big = catalog.models.find((x) => x.id === "o-big");
    if (!big) throw new Error("no model");
    expect(tierOf(policy, big)).toBe("best");
  });
});

describe("the shipped policy (data/routing.json)", () => {
  test("every tier has models, all in the shipped catalog", () => {
    expect(checkPolicy(defaultPolicy, defaultCatalog)).toEqual([]);
  });

  test("every catalog model has a tier", () => {
    expect(defaultCatalog.models.filter((x) => !tierOf(defaultPolicy, x))).toEqual([]);
  });

  test("housekeeping runs on Cheap and no answer can land there (RT-17)", () => {
    expect(new Set(Object.values(defaultPolicy.housekeeping))).toEqual(new Set(["cheap"]));
    for (const intent of ["chat", "writing", "coding", "reasoning"] as const) {
      for (const complexity of ["low", "medium", "high"] as const) {
        expect(chooseTier(defaultPolicy, task({ intent, complexity })).tier).not.toBe("cheap");
      }
    }
  });

  test("hard reasoning, analysis and architecture start on Best; the rest on Balanced", () => {
    const tier = (t: Partial<Task>) => chooseTier(defaultPolicy, task(t)).tier;
    expect(tier({ intent: "reasoning", complexity: "high" })).toBe("best");
    expect(tier({ intent: "analysis", complexity: "high" })).toBe("best");
    expect(tier({ intent: "coding", complexity: "high" })).toBe("best");
    expect(tier({ intent: "coding", complexity: "medium" })).toBe("balanced");
    expect(tier({ intent: "writing", complexity: "high" })).toBe("balanced");
  });

  test("was built from the shipped prices", () => {
    expect(defaultPolicy.builtFromPriceVersion).toBe(defaultCatalog.priceVersion);
  });
});
