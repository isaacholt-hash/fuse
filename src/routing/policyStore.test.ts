// @vitest-environment node
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { defaultPolicy } from "./defaultPolicy";
import { chooseTier, parsePolicy, serializePolicy, type Task } from "./policy";
import {
  loadPolicy,
  loadProjectRules,
  parseRules,
  readPolicyFile,
  rulesToRaw,
  withProjectRules,
} from "./policyStore";

const task: Task = { intent: "writing", complexity: "low", capabilities: [], contextTokens: 10 };

test("a policy survives serialize → parse unchanged", () => {
  expect(parsePolicy(serializePolicy(defaultPolicy))).toEqual(defaultPolicy);
});

test("a saved policy is used only while it parses and fits the catalog", () => {
  const mine = { ...defaultPolicy, providerPreference: ["openai" as const] };
  const raw = JSON.stringify(serializePolicy(mine));
  expect(loadPolicy(defaultPolicy, raw, defaultCatalog)).toEqual(mine);
  expect(loadPolicy(defaultPolicy, "{oops", defaultCatalog)).toBe(defaultPolicy);
  const unknownModel = serializePolicy({
    ...defaultPolicy,
    tiers: defaultPolicy.tiers.map((t, i) => ({
      ...t,
      models: [{ provider: "openai" as const, id: `gone-${String(i)}` }],
    })),
  });
  expect(loadPolicy(defaultPolicy, JSON.stringify(unknownModel), defaultCatalog)).toBe(
    defaultPolicy,
  );
  expect(() => readPolicyFile(JSON.stringify(unknownModel), defaultCatalog)).toThrow(
    /isn't in the catalog/,
  );
  expect(() => readPolicyFile("nope", defaultCatalog)).toThrow("That file isn't JSON.");
});

test("project rules go before the global ones", () => {
  const rules = parseRules(defaultPolicy, [
    { id: "default", when: { intents: ["writing"] }, tier: "best", reason: "Writing here is hard" },
  ]);
  const raw = JSON.stringify({ p1: rulesToRaw(defaultPolicy, rules), p2: "broken" });
  const loaded = loadProjectRules(defaultPolicy, raw);
  expect(Object.keys(loaded)).toEqual(["p1"]);
  const policy = withProjectRules(defaultPolicy, loaded.p1);
  expect(chooseTier(policy, task)).toMatchObject({ tier: "best", rule: { id: "project-default" } });
  expect(chooseTier(defaultPolicy, task).tier).toBe("balanced");
});
