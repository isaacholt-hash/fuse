// Test-only: real provider adapters for the live tests Isaac runs with his own keys, from
// FUSE_OPENAI_API_KEY / FUSE_ANTHROPIC_API_KEY. A key goes only into its request's auth header;
// it's never printed or written anywhere.
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { findModel, type CatalogModel, type CloudProviderId } from "@/catalog/catalog";
import { createAnthropicAdapter } from "@/providers/anthropic/adapter";
import { createOpenAIAdapter } from "@/providers/openai/adapter";
import { SCOPE_HEADER, type FetchLike, type ProviderAdapter } from "@/providers/types";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { tierModels } from "@/routing/policy";

export const KEYS: Record<CloudProviderId, string | undefined> = {
  openai: process.env.FUSE_OPENAI_API_KEY,
  anthropic: process.env.FUSE_ANTHROPIC_API_KEY,
};

/** The providers with a key set. */
export const keyedProviders = () => (["anthropic", "openai"] as const).filter((p) => KEYS[p]);

/** Real fetch with the key added; FUSE's internal scope header stays here. */
function keyedFetch(provider: CloudProviderId, key: string): FetchLike {
  return async (url, init) => {
    const { [SCOPE_HEADER]: _scope, ...headers } = init.headers;
    const auth: Record<string, string> =
      provider === "openai" ? { authorization: `Bearer ${key}` } : { "x-api-key": key };
    return fetch(url, {
      method: init.method,
      headers: { ...headers, ...auth },
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  };
}

export function liveAdapter(provider: CloudProviderId): ProviderAdapter {
  const fetch = keyedFetch(provider, KEYS[provider] ?? "");
  return provider === "openai" ? createOpenAIAdapter({ fetch }) : createAnthropicAdapter({ fetch });
}

/** The model named in `chosen`, or the cheapest Balanced one. */
export function liveModel(
  provider: CloudProviderId,
  chosen: string | undefined,
): CatalogModel | undefined {
  if (chosen) return findModel(defaultCatalog, provider, chosen) ?? undefined;
  return tierModels(defaultPolicy, defaultCatalog, "balanced", { providers: [provider] })[0];
}
