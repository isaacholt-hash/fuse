// @vitest-environment node
import { defaultPolicy } from "./defaultPolicy";
import { suggestRules, withOverride, type Override } from "./learn";
import { chooseTier } from "./policy";

const now = Date.parse("2026-10-29T12:00:00Z");
const o = (fields: Partial<Override>): Override => ({
  intent: "writing",
  complexity: "medium",
  from: "balanced",
  to: "best",
  at: now - 86_400_000,
  ...fields,
});

test("only moves up count as overrides", () => {
  expect(withOverride([], o({ to: "balanced" }))).toEqual([]);
  expect(withOverride([], o({}))).toHaveLength(1);
});

test("three moves up for the same kind of question suggest a rule; two don't", () => {
  const two = [o({}), o({ complexity: "low" })];
  expect(suggestRules(defaultPolicy, two, [], now)).toEqual([]);
  const three = [...two, o({})];
  const [s] = suggestRules(defaultPolicy, three, [], now);
  expect(s).toMatchObject({
    key: "writing->best:low,medium",
    count: 3,
    text: "Writing questions (low or medium) start on Best",
    rule: { when: { intents: ["writing"], complexities: ["low", "medium"] }, tier: "best" },
  });
  // With the rule in place, the policy follows it.
  if (!s) throw new Error("expected a suggestion");
  const after = { ...defaultPolicy, rules: [s.rule, ...defaultPolicy.rules] };
  expect(
    chooseTier(after, { intent: "writing", complexity: "low", capabilities: [], contextTokens: 0 })
      .tier,
  ).toBe("best");
  expect(suggestRules(after, three, [], now)).toEqual([]);
});

test("old overrides and dismissed suggestions don't come back", () => {
  const three = [o({}), o({}), o({})];
  expect(suggestRules(defaultPolicy, three, ["writing->best:medium"], now)).toEqual([]);
  const old = three.map((x) => ({ ...x, at: now - 90 * 86_400_000 }));
  expect(suggestRules(defaultPolicy, old, [], now)).toEqual([]);
});
