import config from "../../data/research.json";
import { ProviderError } from "./errors";
import type { ChatOptions } from "./types";

export const researchLimits = config.limits;
export const searchConfig = config;

export interface SearchSource {
  url: string;
  title: string | null;
}
export interface SearchCall {
  id: string;
  action: "search" | "open_page" | "find_in_page";
  query: string | null;
  sources: SearchSource[];
  truncated: boolean;
  error: string | null;
}

/** A request has a finite provider-enforced bound, including ordinary Chat's search toggle. */
export function searchUses(options: ChatOptions): number | null {
  if (!options.webSearch) {
    if (options.searchBounds)
      throw new ProviderError("invalid_request", "Search bounds require web search.");
    return null;
  }
  const uses = options.searchBounds?.maxUses ?? config.default_search_uses;
  if (!Number.isSafeInteger(uses) || uses < 1 || uses > config.limits.searches)
    throw new ProviderError(
      "invalid_request",
      `Searches per request must be between 1 and ${String(config.limits.searches)}.`,
    );
  return uses;
}

/** Provider metadata is data, never HTML, permissions or an instruction to fetch a new URL. */
export function searchSources(raw: unknown): { sources: SearchSource[]; truncated: boolean } {
  const values = Array.isArray(raw) ? (raw as unknown[]) : [];
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.url !== "string" || entry.url.length > config.max_source_url_chars) continue;
    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      continue;
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      seen.has(url.href)
    )
      continue;
    seen.add(url.href);
    if (sources.length >= config.limits.sources) return { sources, truncated: true };
    sources.push({
      url: url.href,
      title:
        typeof entry.title === "string"
          ? entry.title.slice(0, config.max_source_title_chars)
          : null,
    });
  }
  return { sources, truncated: false };
}

export function reportedSearchCount(raw: unknown): number | null {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}
