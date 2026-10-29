// @vitest-environment node
import { parsePolicy } from "@/routing/policy";
import { parseCatalog } from "./catalog";
import { compareModels, familyOf, isChatModel, withCustomModels } from "./discovery";

const m = (provider: string, id: string) => ({
  provider,
  id,
  display_name: id,
  context_window: 1000,
  max_output: 100,
  price: { input: 1, output: 2 },
  capabilities: ["streaming"],
  verified_on: "2026-10-26",
  source_url: "https://example.com",
});
const catalog = parseCatalog({
  price_version: "2026-10-26",
  models: [
    m("anthropic", "claude-sonnet-5-5"),
    m("anthropic", "claude-haiku-5-5"),
    m("openai", "gpt-6-luna"),
  ],
});
const policy = parsePolicy({
  policy_version: "2026-10-28",
  built_from_price_version: "2026-10-26",
  tiers: [
    { id: "cheap", label: "Cheap", description: "x", models: ["openai/gpt-6-luna"] },
    {
      id: "balanced",
      label: "Balanced",
      description: "x",
      models: ["anthropic/claude-sonnet-5-5"],
    },
    { id: "best", label: "Best", description: "x", models: ["anthropic/claude-haiku-5-5"] },
  ],
  housekeeping: { title: "cheap", classify: "cheap", memory: "cheap", summary: "cheap" },
  quality_floor: { default: "balanced", overrides: [] },
  rules: [{ id: "default", when: {}, tier: "balanced", reason: "Default" }],
});

test("families drop version numbers; only chat models count", () => {
  expect(familyOf("claude-sonnet-5-5")).toBe("claude-sonnet");
  expect(familyOf("gpt-6.1-sol")).toBe("gpt-sol");
  expect(familyOf("claude-sonnet-5-5-20261001")).toBe("claude-sonnet");
  expect(isChatModel("openai", "gpt-6-mini")).toBe(true);
  expect(isChatModel("openai", "gpt-6-audio")).toBe(false);
  expect(isChatModel("openai", "text-embedding-3-small")).toBe(false);
  expect(isChatModel("anthropic", "claude-haiku-5-5")).toBe(true);
});

test("new models are found; a missing tier model is flagged with its family's newest", () => {
  const check = compareModels(
    catalog,
    policy,
    {
      anthropic: [
        { id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" },
        { id: "claude-sonnet-5-6", displayName: "Claude Sonnet 5.6" },
        { id: "claude-sonnet-5-10", displayName: "Claude Sonnet 5.10" },
      ],
      openai: null,
    },
    1,
  );
  expect(check.found.map((f) => f.id)).toEqual(["claude-sonnet-5-10", "claude-sonnet-5-6"]);
  expect(check.missing).toEqual([
    {
      provider: "anthropic",
      id: "claude-sonnet-5-5",
      displayName: "claude-sonnet-5-5",
      tiers: ["balanced"],
      replacement: { id: "claude-sonnet-5-10", inCatalog: false },
    },
  ]);
  expect(check.failed).toEqual(["openai"]);
});

test("hand-added models join the catalog once", () => {
  const [first] = catalog.models;
  if (!first) throw new Error("no models");
  const out = withCustomModels(catalog, [{ ...first, id: "claude-new" }, first]);
  expect(out.models.map((x) => x.id)).toEqual([
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "gpt-6-luna",
    "claude-new",
  ]);
});
