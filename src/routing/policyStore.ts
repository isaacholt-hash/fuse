/**
 * Your routing policy (RT-03): the shipped data/routing.json until you save your own, plus rules
 * per project that are tried before the global ones. Both live in settings as raw JSON.
 */
import type { Catalog } from "@/catalog/catalog";
import { checkPolicy, parsePolicy, serializePolicy, type Rule, type RoutingPolicy } from "./policy";

export const POLICY_SETTING = "routing.policy";
export const PROJECT_RULES_SETTING = "routing.project_rules";

/** Your saved policy if it still parses and fits the catalog, else the shipped one. */
export function loadPolicy(
  shipped: RoutingPolicy,
  raw: string | null,
  catalog: Catalog,
): RoutingPolicy {
  if (!raw) return shipped;
  try {
    const saved = parsePolicy(JSON.parse(raw));
    return checkPolicy(saved, catalog).length === 0 ? saved : shipped;
  } catch {
    return shipped;
  }
}

/** Parses a policy file (import), or throws with what's wrong. */
export function readPolicyFile(text: string, catalog: Catalog): RoutingPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't JSON.");
  }
  const policy = parsePolicy(raw);
  const problems = checkPolicy(policy, catalog);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return policy;
}

/** Rules checked by the same parser as the policy (a project's list may be empty). */
export function parseRules(base: RoutingPolicy, raw: unknown[]): Rule[] {
  const end = { id: "__end", when: {}, tier: "balanced", reason: "End" };
  const parsed = parsePolicy({ ...serializePolicy(base), rules: [...raw, end] });
  return parsed.rules.slice(0, -1);
}

export function rulesToRaw(base: RoutingPolicy, rules: readonly Rule[]): unknown[] {
  const raw = serializePolicy({ ...base, rules: [...rules] }).rules;
  return Array.isArray(raw) ? raw : [];
}

export type ProjectRules = Record<string, Rule[]>;

export function loadProjectRules(base: RoutingPolicy, raw: string | null): ProjectRules {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: ProjectRules = {};
    for (const [id, rules] of Object.entries(parsed)) {
      if (!Array.isArray(rules)) continue;
      try {
        out[id] = parseRules(base, rules);
      } catch {
        // a broken list for one project is dropped, not the others
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** A project's rules go first; the global list (ending in the catch-all) follows. */
export function withProjectRules(
  policy: RoutingPolicy,
  rules: readonly Rule[] | undefined,
): RoutingPolicy {
  if (!rules || rules.length === 0) return policy;
  const ids = new Set(policy.rules.map((r) => r.id));
  return {
    ...policy,
    rules: [
      ...rules.map((r) => (ids.has(r.id) ? { ...r, id: `project-${r.id}` } : r)),
      ...policy.rules,
    ],
  };
}
