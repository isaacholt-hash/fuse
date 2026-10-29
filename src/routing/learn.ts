/**
 * Learn from overrides (RT-11): each time you move an answer up a tier ("Try a stronger model")
 * or pin a stronger tier than Auto would pick, FUSE notes the kind of question. Three or more for
 * the same kind suggest a rule. The policy never changes by itself: a suggestion goes into the
 * policy editor, where it's scored on the routing test set before you save it.
 */
import { INTENT_LABELS } from "./classify";
import {
  chooseTier,
  TIER_ORDER,
  type Complexity,
  type Intent,
  type Rule,
  type RoutingPolicy,
  type TierId,
} from "./policy";

export const OVERRIDES_SETTING = "routing.overrides";
export const DISMISSED_SETTING = "routing.suggestions_dismissed";
/** Overrides this many times for the same kind of question make a suggestion. */
export const SUGGEST_AFTER = 3;
/** Only the last two months count. */
const WINDOW_MS = 60 * 86_400_000;
const KEEP = 200;

export interface Override {
  intent: Intent;
  complexity: Complexity;
  /** The tier Auto picked, and the stronger one you chose. */
  from: TierId;
  to: TierId;
  at: number;
}

export interface RuleSuggestion {
  /** Stable for the same suggestion, to remember a dismissal. */
  key: string;
  /** e.g. "Writing questions start on Best" */
  text: string;
  count: number;
  rule: Rule;
}

const rank = (t: TierId) => TIER_ORDER.indexOf(t);

export function parseJsonList<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** Notes an override if it really is one (a stronger tier); keeps the newest KEEP. */
export function withOverride(list: readonly Override[], o: Override): Override[] {
  if (rank(o.to) <= rank(o.from)) return [...list];
  return [...list, o].slice(-KEEP);
}

/** Rules your overrides suggest that the policy doesn't already follow and you haven't dismissed. */
export function suggestRules(
  policy: RoutingPolicy,
  overrides: readonly Override[],
  dismissed: readonly string[],
  now: number,
): RuleSuggestion[] {
  const groups = new Map<string, Override[]>();
  for (const o of overrides) {
    if (now - o.at > WINDOW_MS) continue;
    const k = `${o.intent}->${o.to}`;
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  const out: RuleSuggestion[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    if (!first || list.length < SUGGEST_AFTER || first.to === "cheap") continue;
    const complexities = [...new Set(list.map((o) => o.complexity))].sort();
    // Already followed: the policy starts every one of these on that tier or higher.
    const followed = complexities.every(
      (complexity) =>
        rank(
          chooseTier(policy, {
            intent: first.intent,
            complexity,
            capabilities: [],
            contextTokens: 0,
          }).tier,
        ) >= rank(first.to),
    );
    if (followed) continue;
    const key = `${first.intent}->${first.to}:${complexities.join(",")}`;
    if (dismissed.includes(key)) continue;
    const label = INTENT_LABELS[first.intent];
    const tierLabel = policy.tiers.find((t) => t.id === first.to)?.label ?? first.to;
    const which = complexities.length === 3 ? "" : ` (${complexities.join(" or ")})`;
    out.push({
      key,
      count: list.length,
      text: `${label[0]?.toUpperCase() ?? ""}${label.slice(1)} questions${which} start on ${tierLabel}`,
      rule: {
        id: `learned-${first.intent}-${first.to}`,
        when: {
          intents: [first.intent],
          ...(complexities.length === 3 ? {} : { complexities }),
        },
        tier: first.to,
        reason: `You often moved ${label} questions up to ${tierLabel}`,
      },
    });
  }
  return out.sort((a, b) => b.count - a.count);
}
