/** Picks the model for one answer from the composer's mode (RT-01): Auto, a pinned tier, or a pinned model. */
import type { Capability, Catalog, CatalogModel, ProviderId } from "@/catalog/catalog";
import { findModel } from "@/catalog/catalog";
import {
  chooseTier,
  tierModels,
  tierOf,
  TIER_ORDER,
  type Complexity,
  type Intent,
  type RoutingPolicy,
  type Task,
  type TierId,
} from "./policy";

export type RouteMode =
  | { kind: "auto" }
  | { kind: "tier"; tier: Exclude<TierId, "cheap"> }
  | { kind: "model"; provider: ProviderId; id: string };

export const AUTO: RouteMode = { kind: "auto" };

/** How an answer's model was picked; stored with the answer (RT-09). */
export interface RouteInfo {
  mode: RouteMode["kind"];
  /** The model's tier; null for a pinned model that's in no tier. */
  tier: TierId | null;
  /** The policy rule that fired (Auto only). */
  ruleId: string | null;
  reason: string;
  intent: Intent | null;
  complexity: Complexity | null;
  /** The cheapest Best model for this request, to price "would have cost $X on Best". */
  best: CatalogModel | null;
}

export type Routed =
  | {
      ok: true;
      model: CatalogModel;
      info: RouteInfo;
      /** Same tier on another provider with a key, for failover (MM-06); null when none. */
      fallback: CatalogModel | null;
    }
  | { ok: false; error: string };

export interface RouteOptions {
  /** Providers with a saved key. */
  providers: readonly ProviderId[];
  /** The chat's current provider, preferred on a price tie. */
  prefer?: ProviderId;
}

const TIER_LABEL = (policy: RoutingPolicy, tier: TierId) =>
  policy.tiers.find((t) => t.id === tier)?.label ?? tier;

/** Capabilities a model must have for this request (the rest are the classifier's notes). */
const needsOf = (task: Task): Capability[] =>
  task.capabilities.filter((c) => c === "vision" || c === "web_search");

/**
 * The cheapest usable model at `from` or the first tier above it that has one: a missing key or
 * capability moves up, never down, so the quality floor holds (RT-17).
 */
function climb(
  policy: RoutingPolicy,
  catalog: Catalog,
  from: TierId,
  task: Task,
  opts: RouteOptions,
): { model: CatalogModel; tier: TierId } | null {
  for (const tier of TIER_ORDER.slice(TIER_ORDER.indexOf(from))) {
    const model = tierModels(policy, catalog, tier, {
      providers: opts.providers,
      needs: needsOf(task),
      inputTokens: task.contextTokens,
      ...(opts.prefer ? { prefer: opts.prefer } : {}),
    })[0];
    if (model) return { model, tier };
  }
  return null;
}

export function route(
  policy: RoutingPolicy,
  catalog: Catalog,
  mode: RouteMode,
  task: Task,
  opts: RouteOptions,
): Routed {
  const best =
    tierModels(policy, catalog, "best", {
      providers: opts.providers,
      inputTokens: task.contextTokens,
    })[0] ?? null;

  if (mode.kind === "model") {
    const model = findModel(catalog, mode.provider, mode.id);
    if (!model)
      return { ok: false, error: `${mode.id} is no longer in the model list. Pick another model.` };
    return {
      ok: true,
      model,
      info: {
        mode: "model",
        tier: tierOf(policy, model) ?? null,
        ruleId: null,
        reason: `You picked ${model.displayName}`,
        intent: null,
        complexity: null,
        best,
      },
      // A model you picked yourself isn't swapped behind your back.
      fallback: null,
    };
  }

  const start = mode.kind === "tier" ? { tier: mode.tier, rule: null } : chooseTier(policy, task);
  const found = climb(policy, catalog, start.tier, task, opts);
  if (!found) {
    return {
      ok: false,
      error: `No model at ${TIER_LABEL(policy, start.tier)} or above can take this with your saved keys. Add a key in Settings, or pick a model (Ctrl+K).`,
    };
  }
  const raised =
    "raisedToFloor" in start && start.raisedToFloor ? " (raised to the quality floor)" : "";
  const moved =
    found.tier === start.tier
      ? ""
      : ` (moved up to ${TIER_LABEL(policy, found.tier)}: no usable model below)`;
  return {
    ok: true,
    model: found.model,
    info: {
      mode: mode.kind,
      tier: found.tier,
      ruleId: start.rule?.id ?? null,
      reason:
        (start.rule ? start.rule.reason : `You pinned ${TIER_LABEL(policy, start.tier)}`) +
        raised +
        moved,
      intent: mode.kind === "auto" ? task.intent : null,
      complexity: mode.kind === "auto" ? task.complexity : null,
      best,
    },
    fallback:
      tierModels(policy, catalog, found.tier, {
        providers: opts.providers.filter((p) => p !== found.model.provider),
        needs: needsOf(task),
        inputTokens: task.contextTokens,
      })[0] ?? null,
  };
}

/** The mode a thread is pinned to: a model, a tier, or neither (Auto). */
export function modeOf(pins: {
  pinnedTier: "balanced" | "best" | null;
  pinnedProvider: ProviderId | null;
  pinnedModel: string | null;
}): RouteMode {
  if (pins.pinnedProvider && pins.pinnedModel) {
    return { kind: "model", provider: pins.pinnedProvider, id: pins.pinnedModel };
  }
  if (pins.pinnedTier) return { kind: "tier", tier: pins.pinnedTier };
  return AUTO;
}
