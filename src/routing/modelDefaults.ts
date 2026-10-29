/**
 * Per-model defaults (MM-07): the most output a model may write, its reasoning effort, and a
 * system-prompt prefix, set for a tier, a model or a project. The more specific wins, field by
 * field: project over model over tier. No temperature: neither provider accepts one on its
 * current models (docs/providers.md).
 */
import type { Effort } from "@/providers/types";
import type { TierId } from "./policy";

export const DEFAULTS_SETTING = "models.defaults";

export interface ModelDefaults {
  maxOutputTokens?: number;
  effort?: Effort;
  /** Put before the system prompt (instructions, memory). */
  prefix?: string;
}

/** Keys: `tier:balanced`, `model:anthropic/claude-sonnet-5-5`, `project:<id>`. */
export type DefaultsMap = Record<string, ModelDefaults>;

export const tierKey = (tier: TierId) => `tier:${tier}`;
export const modelDefaultsKey = (provider: string, id: string) => `model:${provider}/${id}`;
export const projectKey = (id: string) => `project:${id}`;

export function parseDefaults(raw: string | null): DefaultsMap {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as DefaultsMap) : {};
  } catch {
    return {};
  }
}

/** The defaults for one request: tier, then model, then project, each field overriding. */
export function resolveDefaults(
  all: DefaultsMap,
  at: { provider: string; id: string; tier: TierId | null; projectId: string | null },
): ModelDefaults {
  const layers = [
    at.tier ? all[tierKey(at.tier)] : undefined,
    all[modelDefaultsKey(at.provider, at.id)],
    at.projectId ? all[projectKey(at.projectId)] : undefined,
  ];
  const out: ModelDefaults = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.maxOutputTokens) out.maxOutputTokens = layer.maxOutputTokens;
    if (layer.effort) out.effort = layer.effort;
    if (layer.prefix?.trim()) out.prefix = layer.prefix.trim();
  }
  return out;
}
