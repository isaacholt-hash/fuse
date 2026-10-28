// @vitest-environment node
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import { parsePolicy, type Task } from "./policy";
import { AUTO, modeOf, route } from "./route";

const model = (provider: "anthropic" | "openai", id: string, price: number, caps: string[]) => ({
  provider,
  id,
  display_name: id,
  context_window: 100_000,
  max_output: 1000,
  price: { input: price, output: price * 5 },
  capabilities: caps,
  verified_on: "2026-10-28",
  source_url: "https://example.com",
});
const catalog = parseCatalog({
  price_version: "2026-10-28",
  models: [
    model("openai", "small", 0.1, ["vision"]),
    model("anthropic", "mid-a", 3, []),
    model("openai", "mid-o", 2, []),
    model("anthropic", "top-a", 15, ["vision"]),
    model("openai", "top-o", 10, ["vision"]),
  ],
});
const policy = parsePolicy({
  policy_version: "2026-10-28",
  built_from_price_version: "2026-10-28",
  tiers: [
    { id: "cheap", label: "Cheap", description: "x", models: ["openai/small"] },
    {
      id: "balanced",
      label: "Balanced",
      description: "x",
      models: ["anthropic/mid-a", "openai/mid-o"],
    },
    { id: "best", label: "Best", description: "x", models: ["anthropic/top-a", "openai/top-o"] },
  ],
  housekeeping: { title: "cheap", classify: "cheap", memory: "cheap", summary: "cheap" },
  quality_floor: {
    default: "balanced",
    overrides: [{ intents: ["analysis"], complexities: ["high"], tier: "best" }],
  },
  rules: [
    {
      id: "hard",
      when: { intents: ["reasoning"], complexities: ["high"] },
      tier: "best",
      reason: "Hard",
    },
    { id: "default", when: {}, tier: "balanced", reason: "Everyday" },
  ],
});
const task = (fields: Partial<Task> = {}): Task => ({
  intent: "chat",
  complexity: "low",
  capabilities: [],
  contextTokens: 1000,
  ...fields,
});
const both = { providers: ["anthropic", "openai"] as const };
const picked = (r: ReturnType<typeof route>) => (r.ok ? r.model.id : r.error);

test("Auto: the rule's tier, then the cheapest model with a key", () => {
  const r = route(policy, catalog, AUTO, task(), both);
  expect(picked(r)).toBe("mid-o");
  expect(r.ok && r.info).toMatchObject({
    mode: "auto",
    tier: "balanced",
    ruleId: "default",
    reason: "Everyday",
    intent: "chat",
    complexity: "low",
  });
  const hard = route(
    policy,
    catalog,
    AUTO,
    task({ intent: "reasoning", complexity: "high" }),
    both,
  );
  expect(hard.ok && [hard.model.id, hard.info.tier, hard.info.ruleId]).toEqual([
    "top-o",
    "best",
    "hard",
  ]);
});

test("Auto never goes below the quality floor, and says so", () => {
  const r = route(policy, catalog, AUTO, task({ intent: "analysis", complexity: "high" }), both);
  expect(r.ok && [r.info.tier, r.info.ruleId, r.info.reason]).toEqual([
    "best",
    "default",
    "Everyday (raised to the quality floor)",
  ]);
});

test("a missing key or capability moves up a tier, never down", () => {
  const anthropicOnly = { providers: ["anthropic"] as const };
  expect(picked(route(policy, catalog, AUTO, task(), anthropicOnly))).toBe("mid-a");
  // No Balanced model reads images: Best does.
  const r = route(policy, catalog, AUTO, task({ capabilities: ["vision"] }), both);
  expect(r.ok && [r.model.id, r.info.reason]).toEqual([
    "top-o",
    "Everyday (moved up to Best: no usable model below)",
  ]);
  const none = route(policy, catalog, AUTO, task(), { providers: [] });
  expect(none.ok).toBe(false);
  expect(picked(none)).toMatch(/^No model at Balanced or above/);
});

test("pinned tier and pinned model", () => {
  const tier = route(policy, catalog, { kind: "tier", tier: "best" }, task(), both);
  expect(tier.ok && [tier.model.id, tier.info.mode, tier.info.ruleId, tier.info.reason]).toEqual([
    "top-o",
    "tier",
    null,
    "You pinned Best",
  ]);
  const pinned = route(
    policy,
    catalog,
    { kind: "model", provider: "anthropic", id: "mid-a" },
    task(),
    both,
  );
  expect(pinned.ok && [pinned.model.id, pinned.info.tier, pinned.info.reason]).toEqual([
    "mid-a",
    "balanced",
    "You picked mid-a",
  ]);
  const gone = route(
    policy,
    catalog,
    { kind: "model", provider: "openai", id: "retired" },
    task(),
    both,
  );
  expect(gone.ok).toBe(false);
});

test("every route names the cheapest Best model, to price the answer on Best", () => {
  const r = route(policy, catalog, AUTO, task(), { providers: ["anthropic"] });
  expect(r.ok && (r.info.best as CatalogModel).id).toBe("top-a");
});

test("a thread's pins read back as a mode", () => {
  const none = { pinnedTier: null, pinnedProvider: null, pinnedModel: null };
  expect(modeOf(none)).toEqual(AUTO);
  expect(modeOf({ ...none, pinnedTier: "best" })).toEqual({ kind: "tier", tier: "best" });
  expect(modeOf({ ...none, pinnedProvider: "openai", pinnedModel: "mid-o" })).toEqual({
    kind: "model",
    provider: "openai",
    id: "mid-o",
  });
});

test("a fallback on the other provider in the same tier, for failover; none for a pinned model", () => {
  const r = route(policy, catalog, AUTO, task(), both);
  expect(r.ok && [r.model.id, r.fallback?.id]).toEqual(["mid-o", "mid-a"]);
  const one = route(policy, catalog, AUTO, task(), { providers: ["openai"] });
  expect(one.ok && one.fallback).toBeNull();
  const pinned = route(
    policy,
    catalog,
    { kind: "model", provider: "openai", id: "mid-o" },
    task(),
    both,
  );
  expect(pinned.ok && pinned.fallback).toBeNull();
});

test("hard questions get high reasoning effort; the rest keep the model's default", () => {
  const hard = route(policy, catalog, AUTO, task({ intent: "chat", complexity: "high" }), both);
  expect(hard.ok && hard.info.effort).toBe("high");
  for (const complexity of ["low", "medium"] as const) {
    const r = route(policy, catalog, AUTO, task({ complexity }), both);
    expect(r.ok && r.info.effort).toBeNull();
  }
});
