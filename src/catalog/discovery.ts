/**
 * Model discovery and deprecations (MM-03, MM-08): the providers' own model lists against the
 * catalog. New chat models can be added by hand (with prices you enter); a catalog model the
 * provider no longer lists is flagged, with the newest model of the same family suggested.
 */
import type { RemoteModel } from "@/providers/types";
import type { RoutingPolicy, TierId } from "@/routing/policy";
import type { Catalog, CatalogModel, ProviderId } from "./catalog";
import { modelKey } from "./prices";

/** Settings keys: models you added (JSON list), and the last check's result (JSON). */
export const CUSTOM_MODELS_SETTING = "catalog.custom_models";
export const MODEL_CHECK_SETTING = "catalog.model_check";
/** The model lists are read again after this long. */
export const MODEL_CHECK_DAYS = 7;

/** Where a hand-added model's prices are checked. */
export const PRICING_PAGE: Record<ProviderId, string> = {
  // Local models are free to run; this is where their files come from (data/local-models.json).
  local: "https://huggingface.co/Qwen",
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
  openai: "https://developers.openai.com/api/docs/pricing",
};

/** Chat models only: provider lists also hold embedding, audio, image and moderation models. */
export function isChatModel(provider: ProviderId, id: string): boolean {
  // Anthropic lists only Claude chat models.
  if (provider === "anthropic") return true;
  return (
    /^(gpt-|o\d|chatgpt-)/.test(id) &&
    !/(audio|realtime|tts|transcribe|image|embedding|moderation|search)/.test(id)
  );
}

/** A model's family: its id without version numbers or dates ("claude-sonnet-5-5" → "claude-sonnet"). */
export const familyOf = (id: string) =>
  id
    .replace(/[-.]?\d+([-.]\d+)*/g, "")
    .replace(/-+/g, "-")
    .replace(/-$/, "");

const newestFirst = (a: string, b: string) => b.localeCompare(a, "en", { numeric: true });

export interface MissingModel {
  provider: ProviderId;
  id: string;
  displayName: string;
  /** Tiers that use it: these are the ones that matter. */
  tiers: TierId[];
  /** The newest listed model of the same family, if any. */
  replacement: { id: string; inCatalog: boolean } | null;
}

export interface ModelCheck {
  checkedAt: number;
  /** Chat models the provider lists that the catalog doesn't have. */
  found: { provider: ProviderId; id: string; displayName: string }[];
  missing: MissingModel[];
  /** Providers whose list couldn't be read (no key, offline). */
  failed: ProviderId[];
}

export function compareModels(
  catalog: Catalog,
  policy: RoutingPolicy,
  lists: Partial<Record<ProviderId, RemoteModel[] | null>>,
  now: number,
): ModelCheck {
  const known = new Set(catalog.models.map(modelKey));
  const found: ModelCheck["found"] = [];
  const missing: MissingModel[] = [];
  const failed: ProviderId[] = [];
  for (const provider of ["anthropic", "openai"] as const) {
    const list = lists[provider];
    if (list === undefined) continue;
    // A provider never lists nothing: an empty list is a failed read, not "every model is gone".
    if (list === null || list.length === 0) {
      failed.push(provider);
      continue;
    }
    const listed = new Set(list.map((m) => m.id));
    for (const m of list) {
      if (!isChatModel(provider, m.id) || known.has(`${provider}/${m.id}`)) continue;
      found.push({ provider, id: m.id, displayName: m.displayName ?? m.id });
    }
    for (const m of catalog.models.filter((c) => c.provider === provider)) {
      if (listed.has(m.id)) continue;
      const family = familyOf(m.id);
      const candidates = [
        ...listed,
        ...catalog.models.filter((c) => c.provider === provider).map((c) => c.id),
      ]
        .filter((id) => id !== m.id && familyOf(id) === family && listed.has(id))
        .sort(newestFirst);
      const best = candidates[0];
      missing.push({
        provider,
        id: m.id,
        displayName: m.displayName,
        tiers: policy.tiers
          .filter((t) => t.models.some((x) => x.provider === provider && x.id === m.id))
          .map((t) => t.id),
        replacement: best ? { id: best, inCatalog: known.has(`${provider}/${best}`) } : null,
      });
    }
  }
  found.sort((a, b) => a.provider.localeCompare(b.provider) || newestFirst(a.id, b.id));
  return { checkedAt: now, found, missing, failed };
}

/** Models you added by hand, on top of the price list (before your price edits). */
export function withCustomModels(base: Catalog, custom: readonly CatalogModel[]): Catalog {
  const known = new Set(base.models.map(modelKey));
  const extra = custom.filter((m) => !known.has(modelKey(m)));
  return extra.length === 0 ? base : { ...base, models: [...base.models, ...extra] };
}

export function parseCustomModels(raw: string | null): CatalogModel[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CatalogModel[]) : [];
  } catch {
    return [];
  }
}

export function parseModelCheck(raw: string | null): ModelCheck | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ModelCheck;
  } catch {
    return null;
  }
}
