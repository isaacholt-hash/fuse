/** Tiers and the routing policy, loaded from data/routing.json (RT-03, RT-17). Never constants. */
import {
  findModel,
  priceFor,
  type Capability,
  type Catalog,
  type CatalogModel,
  type ProviderId,
} from "@/catalog/catalog";

/** Ordered weakest to strongest. */
export type TierId = "cheap" | "balanced" | "best";
export const TIER_ORDER: readonly TierId[] = ["cheap", "balanced", "best"];

/** RT-02's task intents. */
export type Intent =
  | "chat"
  | "writing"
  | "coding"
  | "analysis"
  | "long_document"
  | "reasoning"
  | "vision"
  | "creative";
export type Complexity = "low" | "medium" | "high";
/** Jobs FUSE runs for itself; they map to a tier but never answer the user. */
export type HousekeepingPurpose = "title" | "classify" | "memory" | "summary";

export interface Tier {
  id: TierId;
  label: string;
  description: string;
  models: { provider: ProviderId; id: string }[];
}

/** Every listed condition must hold; an empty `when` matches everything. */
export interface RuleMatch {
  intents?: Intent[];
  complexities?: Complexity[];
  /** The task needs at least one of these. */
  capabilities?: Capability[];
  minContextTokens?: number;
}

export interface Rule {
  id: string;
  when: RuleMatch;
  tier: TierId;
  /** Shown with the answer (RT-09). */
  reason: string;
}

export interface FloorOverride {
  intents?: Intent[];
  complexities?: Complexity[];
  tier: TierId;
}

export interface RoutingPolicy {
  policyVersion: string;
  builtFromPriceVersion: string;
  tiers: Tier[];
  housekeeping: Record<HousekeepingPurpose, TierId>;
  floor: { default: TierId; overrides: FloorOverride[] };
  /** Tie-break among equally cheap models; empty means no preference (RT-06). */
  providerPreference: ProviderId[];
  /** First match wins; the last rule matches everything. */
  rules: Rule[];
}

export interface Task {
  intent: Intent;
  complexity: Complexity;
  capabilities: Capability[];
  contextTokens: number;
}

const INTENTS: readonly Intent[] = [
  "chat",
  "writing",
  "coding",
  "analysis",
  "long_document",
  "reasoning",
  "vision",
  "creative",
];
const COMPLEXITIES: readonly Complexity[] = ["low", "medium", "high"];
const PURPOSES: readonly HousekeepingPurpose[] = ["title", "classify", "memory", "summary"];
const PROVIDERS: readonly ProviderId[] = ["openai", "anthropic"];
const CAPABILITIES: readonly Capability[] = [
  "vision",
  "reasoning",
  "tools",
  "json",
  "streaming",
  "web_search",
];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class PolicyError extends Error {}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new PolicyError(`${where}: expected an object`);
  }
  return v as Record<string, unknown>;
}
function str(o: Record<string, unknown>, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0)
    throw new PolicyError(`${where}.${k}: expected text`);
  return v;
}
function date(o: Record<string, unknown>, k: string, where: string): string {
  const v = str(o, k, where);
  if (!DATE.test(v)) throw new PolicyError(`${where}.${k}: expected YYYY-MM-DD`);
  return v;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], where: string): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new PolicyError(`${where}: expected one of ${allowed.join(", ")}`);
  }
  return v as T;
}
function listOf<T extends string>(
  o: Record<string, unknown>,
  k: string,
  allowed: readonly T[],
  where: string,
): T[] | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0) {
    throw new PolicyError(`${where}.${k}: expected a non-empty list`);
  }
  return v.map((x, i) => oneOf(x, allowed, `${where}.${k}[${String(i)}]`));
}
/** RT-17: Cheap is housekeeping only, so no rule or floor may send an answer there. */
function answerTier(v: unknown, where: string): TierId {
  const tier = oneOf(v, TIER_ORDER, where);
  if (tier === "cheap") throw new PolicyError(`${where}: the Cheap tier never answers the user`);
  return tier;
}

/** Validates the raw JSON (snake_case, as stored in data/routing.json) and returns a typed policy. */
export function parsePolicy(raw: unknown): RoutingPolicy {
  const root = obj(raw, "policy");

  if (!Array.isArray(root.tiers)) throw new PolicyError("policy.tiers: expected a list");
  const seenModels = new Set<string>();
  const tiers = root.tiers.map((t: unknown, i): Tier => {
    const where = `tiers[${String(i)}]`;
    const o = obj(t, where);
    const id = oneOf(o.id, TIER_ORDER, `${where}.id`);
    if (id !== TIER_ORDER[i]) {
      throw new PolicyError(`policy.tiers: expected ${TIER_ORDER.join(", ")} in that order`);
    }
    if (!Array.isArray(o.models)) throw new PolicyError(`${where}.models: expected a list`);
    const models = o.models.map((m: unknown, j) => {
      const mw = `${where}.models[${String(j)}]`;
      const [provider, ...rest] = typeof m === "string" ? m.split("/") : [];
      const modelId = rest.join("/");
      if (!modelId) throw new PolicyError(`${mw}: expected "provider/model-id"`);
      const p = oneOf(provider, PROVIDERS, `${mw} provider`);
      const key = `${p}/${modelId}`;
      if (seenModels.has(key)) throw new PolicyError(`${mw}: ${key} is in more than one tier`);
      seenModels.add(key);
      return { provider: p, id: modelId };
    });
    return { id, label: str(o, "label", where), description: str(o, "description", where), models };
  });
  if (tiers.length !== TIER_ORDER.length) {
    throw new PolicyError(`policy.tiers: expected ${TIER_ORDER.join(", ")} in that order`);
  }

  const hk = obj(root.housekeeping, "policy.housekeeping");
  const housekeeping = Object.fromEntries(
    PURPOSES.map((p) => [p, oneOf(hk[p], TIER_ORDER, `housekeeping.${p}`)]),
  ) as Record<HousekeepingPurpose, TierId>;

  const qf = obj(root.quality_floor, "policy.quality_floor");
  if (!Array.isArray(qf.overrides)) {
    throw new PolicyError("quality_floor.overrides: expected a list");
  }
  const floor = {
    default: answerTier(qf.default, "quality_floor.default"),
    overrides: qf.overrides.map((f: unknown, i): FloorOverride => {
      const where = `quality_floor.overrides[${String(i)}]`;
      const o = obj(f, where);
      const out: FloorOverride = { tier: answerTier(o.tier, `${where}.tier`) };
      const intents = listOf(o, "intents", INTENTS, where);
      const complexities = listOf(o, "complexities", COMPLEXITIES, where);
      if (intents) out.intents = intents;
      if (complexities) out.complexities = complexities;
      return out;
    }),
  };

  const pref = root.provider_preference ?? [];
  if (!Array.isArray(pref)) throw new PolicyError("policy.provider_preference: expected a list");
  const providerPreference = pref.map((p, i) =>
    oneOf(p, PROVIDERS, `provider_preference[${String(i)}]`),
  );

  if (!Array.isArray(root.rules) || root.rules.length === 0) {
    throw new PolicyError("policy.rules: expected a non-empty list");
  }
  const ruleIds = new Set<string>();
  const rules = root.rules.map((r: unknown, i): Rule => {
    const where = `rules[${String(i)}]`;
    const o = obj(r, where);
    const id = str(o, "id", where);
    if (ruleIds.has(id)) throw new PolicyError(`${where}: duplicate rule id "${id}"`);
    ruleIds.add(id);
    const w = obj(o.when, `${where}.when`);
    const when: RuleMatch = {};
    const intents = listOf(w, "intents", INTENTS, `${where}.when`);
    const complexities = listOf(w, "complexities", COMPLEXITIES, `${where}.when`);
    const capabilities = listOf(w, "capabilities", CAPABILITIES, `${where}.when`);
    if (intents) when.intents = intents;
    if (complexities) when.complexities = complexities;
    if (capabilities) when.capabilities = capabilities;
    if (w.min_context_tokens !== undefined) {
      const n = w.min_context_tokens;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
        throw new PolicyError(`${where}.when.min_context_tokens: expected a whole number`);
      }
      when.minContextTokens = n;
    }
    return {
      id,
      when,
      tier: answerTier(o.tier, `${where}.tier`),
      reason: str(o, "reason", where),
    };
  });
  const last = rules[rules.length - 1];
  if (last && Object.keys(last.when).length > 0) {
    throw new PolicyError("policy.rules: the last rule must match everything (an empty `when`)");
  }

  return {
    policyVersion: date(root, "policy_version", "policy"),
    builtFromPriceVersion: date(root, "built_from_price_version", "policy"),
    tiers,
    housekeeping,
    floor,
    providerPreference,
    rules,
  };
}

/** Problems with the policy against a catalog: unknown models, empty tiers. Empty means fine. */
export function checkPolicy(policy: RoutingPolicy, catalog: Catalog): string[] {
  const problems: string[] = [];
  for (const tier of policy.tiers) {
    if (tier.models.length === 0) problems.push(`The ${tier.label} tier has no models`);
    for (const m of tier.models) {
      if (!findModel(catalog, m.provider, m.id)) {
        problems.push(`${tier.label} lists ${m.provider}/${m.id}, which isn't in the catalog`);
      }
    }
  }
  return problems;
}

const rank = (t: TierId) => TIER_ORDER.indexOf(t);
const higher = (a: TierId, b: TierId) => (rank(a) >= rank(b) ? a : b);

export function tierOf(policy: RoutingPolicy, model: CatalogModel): TierId | undefined {
  return policy.tiers.find((t) =>
    t.models.some((m) => m.provider === model.provider && m.id === model.id),
  )?.id;
}

/** The lowest tier allowed to answer this task (RT-17). */
export function floorFor(policy: RoutingPolicy, intent: Intent, complexity: Complexity): TierId {
  return policy.floor.overrides
    .filter(
      (f) =>
        (!f.intents || f.intents.includes(intent)) &&
        (!f.complexities || f.complexities.includes(complexity)),
    )
    .reduce((tier, f) => higher(tier, f.tier), policy.floor.default);
}

function matches(when: RuleMatch, task: Task): boolean {
  return (
    (!when.intents || when.intents.includes(task.intent)) &&
    (!when.complexities || when.complexities.includes(task.complexity)) &&
    (!when.capabilities || when.capabilities.some((c) => task.capabilities.includes(c))) &&
    (when.minContextTokens === undefined || task.contextTokens >= when.minContextTokens)
  );
}

export interface TierChoice {
  tier: TierId;
  rule: Rule;
  /** The rule asked for less than the quality floor allows. */
  raisedToFloor: boolean;
}

/** The first matching rule's tier, never below the floor. */
export function chooseTier(policy: RoutingPolicy, task: Task): TierChoice {
  const rule = policy.rules.find((r) => matches(r.when, task));
  // parsePolicy guarantees the last rule matches everything.
  if (!rule) throw new Error("routing policy has no catch-all rule");
  const floor = floorFor(policy, task.intent, task.complexity);
  const tier = higher(rule.tier, floor);
  return { tier, rule, raisedToFloor: tier !== rule.tier };
}

export interface TierModelOptions {
  /** Providers with a saved key. */
  providers: readonly ProviderId[];
  /** Capabilities the request needs (e.g. vision for an image). */
  needs?: readonly Capability[];
  /** Input size, for long-context prices and context fit. */
  inputTokens?: number;
  /** The chat's current provider, preferred on a tie after the policy's preference. */
  prefer?: ProviderId;
  /** RT-06: measured median time to first token per `provider/model`, for price ties. */
  latency?: Readonly<Record<string, number>>;
}

/**
 * The tier's usable models, cheapest first by input + output price at this input size.
 * Ties go to the faster model where both have been measured (RT-06), then the policy's provider
 * preference, then `prefer`, then the order in routing.json.
 */
export function tierModels(
  policy: RoutingPolicy,
  catalog: Catalog,
  tier: TierId,
  opts: TierModelOptions,
): CatalogModel[] {
  const inputTokens = opts.inputTokens ?? 0;
  const pref = (p: ProviderId) => {
    const i = policy.providerPreference.indexOf(p);
    return i === -1 ? policy.providerPreference.length : i;
  };
  const price = (m: CatalogModel) => {
    const p = priceFor(m, inputTokens);
    return p.input + p.output;
  };
  const speed = (a: CatalogModel, b: CatalogModel) => {
    const ta = opts.latency?.[`${a.provider}/${a.id}`];
    const tb = opts.latency?.[`${b.provider}/${b.id}`];
    return ta === undefined || tb === undefined ? 0 : ta - tb;
  };
  return (policy.tiers.find((t) => t.id === tier)?.models ?? [])
    .map((ref) => findModel(catalog, ref.provider, ref.id))
    .filter((m): m is CatalogModel => m !== undefined)
    .filter(
      (m) =>
        opts.providers.includes(m.provider) &&
        (opts.needs ?? []).every((c) => m.capabilities.includes(c)) &&
        m.contextWindow > inputTokens,
    )
    .sort(
      (a, b) =>
        price(a) - price(b) ||
        speed(a, b) ||
        pref(a.provider) - pref(b.provider) ||
        Number(b.provider === opts.prefer) - Number(a.provider === opts.prefer),
    );
}

/** The policy as raw JSON again (the shape of data/routing.json): parsePolicy's inverse. */
export function serializePolicy(policy: RoutingPolicy): Record<string, unknown> {
  const match = (m: RuleMatch | FloorOverride) => ({
    ...(m.intents ? { intents: m.intents } : {}),
    ...(m.complexities ? { complexities: m.complexities } : {}),
    ...("capabilities" in m && m.capabilities ? { capabilities: m.capabilities } : {}),
    ...("minContextTokens" in m && m.minContextTokens !== undefined
      ? { min_context_tokens: m.minContextTokens }
      : {}),
  });
  return {
    policy_version: policy.policyVersion,
    built_from_price_version: policy.builtFromPriceVersion,
    tiers: policy.tiers.map((t) => ({
      id: t.id,
      label: t.label,
      description: t.description,
      models: t.models.map((m) => `${m.provider}/${m.id}`),
    })),
    housekeeping: policy.housekeeping,
    quality_floor: {
      default: policy.floor.default,
      overrides: policy.floor.overrides.map((f) => ({ ...match(f), tier: f.tier })),
    },
    provider_preference: policy.providerPreference,
    rules: policy.rules.map((r) => ({
      id: r.id,
      when: match(r.when),
      tier: r.tier,
      reason: r.reason,
    })),
  };
}
