/** Model catalog loaded from data/models.json. Prices are data, never code constants. */
export type ProviderId = "openai" | "anthropic";

export type Capability = "vision" | "reasoning" | "tools" | "json" | "streaming" | "web_search";

/** US dollars per 1M tokens. Optional fields fall back to `input` in cost(). */
export interface ModelPrice {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
}

export interface CatalogModel {
  provider: ProviderId;
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number;
  price: ModelPrice;
  /** Higher rates once a request's input passes `aboveInputTokens`. */
  longContextPrice?: ModelPrice & { aboveInputTokens: number };
  capabilities: Capability[];
  verifiedOn: string;
  sourceUrl: string;
  notes?: string;
}

/** A per-call fee for a provider's server-side tool (e.g. web search), on top of tokens. */
export type ToolId = "web_search";

export interface ToolPrice {
  provider: ProviderId;
  tool: ToolId;
  /** US dollars per call. */
  usdPerCall: number;
  verifiedOn: string;
  sourceUrl: string;
  notes?: string;
}

export interface Catalog {
  /** Stamped on every priced row (messages, request_log). */
  priceVersion: string;
  models: CatalogModel[];
  toolPrices: ToolPrice[];
}

const PROVIDERS: readonly ProviderId[] = ["openai", "anthropic"];
const CAPABILITIES: readonly Capability[] = [
  "vision",
  "reasoning",
  "tools",
  "json",
  "streaming",
  "web_search",
];
const TOOLS: readonly ToolId[] = ["web_search"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class CatalogError extends Error {}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new CatalogError(`${where}: expected an object`);
  }
  return v as Record<string, unknown>;
}
function str(o: Record<string, unknown>, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0)
    throw new CatalogError(`${where}.${k}: expected text`);
  return v;
}
function num(o: Record<string, unknown>, k: string, where: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new CatalogError(`${where}.${k}: expected a non-negative number`);
  }
  return v;
}
function optNum(o: Record<string, unknown>, k: string, where: string): number | undefined {
  return o[k] === undefined ? undefined : num(o, k, where);
}

function parsePrice(v: unknown, where: string): ModelPrice {
  const o = obj(v, where);
  const price: ModelPrice = { input: num(o, "input", where), output: num(o, "output", where) };
  const cachedInput = optNum(o, "cached_input", where);
  const cacheWrite = optNum(o, "cache_write", where);
  if (cachedInput !== undefined) price.cachedInput = cachedInput;
  if (cacheWrite !== undefined) price.cacheWrite = cacheWrite;
  return price;
}

/** Validates the raw JSON (snake_case, as stored in data/models.json) and returns a typed catalog. */
export function parseCatalog(raw: unknown): Catalog {
  const root = obj(raw, "catalog");
  const priceVersion = str(root, "price_version", "catalog");
  if (!DATE.test(priceVersion))
    throw new CatalogError("catalog.price_version: expected YYYY-MM-DD");
  if (!Array.isArray(root.models) || root.models.length === 0) {
    throw new CatalogError("catalog.models: expected a non-empty list");
  }
  const seen = new Set<string>();
  const models = root.models.map((m: unknown, i): CatalogModel => {
    const where = `models[${String(i)}]`;
    const o = obj(m, where);
    const provider = str(o, "provider", where);
    if (!PROVIDERS.includes(provider as ProviderId)) {
      throw new CatalogError(`${where}.provider: unknown provider "${provider}"`);
    }
    const id = str(o, "id", where);
    const key = `${provider}/${id}`;
    if (seen.has(key)) throw new CatalogError(`${where}: duplicate model ${key}`);
    seen.add(key);
    const caps = o.capabilities;
    if (!Array.isArray(caps) || !caps.every((c) => CAPABILITIES.includes(c as Capability))) {
      throw new CatalogError(
        `${where}.capabilities: expected a list of ${CAPABILITIES.join(", ")}`,
      );
    }
    const verifiedOn = str(o, "verified_on", where);
    if (!DATE.test(verifiedOn)) throw new CatalogError(`${where}.verified_on: expected YYYY-MM-DD`);
    const sourceUrl = str(o, "source_url", where);
    if (!sourceUrl.startsWith("https://")) {
      throw new CatalogError(`${where}.source_url: expected an https URL`);
    }
    const model: CatalogModel = {
      provider: provider as ProviderId,
      id,
      displayName: str(o, "display_name", where),
      contextWindow: num(o, "context_window", where),
      maxOutput: num(o, "max_output", where),
      price: parsePrice(o.price, `${where}.price`),
      capabilities: caps as Capability[],
      verifiedOn,
      sourceUrl,
    };
    if (o.long_context_price !== undefined) {
      const lw = `${where}.long_context_price`;
      const lo = obj(o.long_context_price, lw);
      model.longContextPrice = {
        ...parsePrice(lo, lw),
        aboveInputTokens: num(lo, "above_input_tokens", lw),
      };
    }
    if (typeof o.notes === "string") model.notes = o.notes;
    return model;
  });
  const toolPrices = (Array.isArray(root.tool_prices) ? root.tool_prices : []).map(
    (t: unknown, i): ToolPrice => {
      const where = `tool_prices[${String(i)}]`;
      const o = obj(t, where);
      const provider = str(o, "provider", where);
      if (!PROVIDERS.includes(provider as ProviderId)) {
        throw new CatalogError(`${where}.provider: unknown provider "${provider}"`);
      }
      const tool = str(o, "tool", where);
      if (!TOOLS.includes(tool as ToolId))
        throw new CatalogError(`${where}.tool: unknown tool "${tool}"`);
      const verifiedOn = str(o, "verified_on", where);
      if (!DATE.test(verifiedOn))
        throw new CatalogError(`${where}.verified_on: expected YYYY-MM-DD`);
      const sourceUrl = str(o, "source_url", where);
      if (!sourceUrl.startsWith("https://")) {
        throw new CatalogError(`${where}.source_url: expected an https URL`);
      }
      const price: ToolPrice = {
        provider: provider as ProviderId,
        tool: tool as ToolId,
        usdPerCall: num(o, "usd_per_call", where),
        verifiedOn,
        sourceUrl,
      };
      if (typeof o.notes === "string") price.notes = o.notes;
      return price;
    },
  );
  return { priceVersion, models, toolPrices };
}

export function toolPrice(
  catalog: Catalog,
  provider: ProviderId,
  tool: ToolId,
): ToolPrice | undefined {
  // `tool` is compared as a string: ToolId has one member today, more come with M2 tools.
  const name: string = tool;
  return catalog.toolPrices.find((t) => t.provider === provider && t.tool === name);
}

/** The price that applies to a request with this many input tokens (all input kinds counted). */
export function priceFor(model: CatalogModel, totalInputTokens: number): ModelPrice {
  const lc = model.longContextPrice;
  return lc && totalInputTokens > lc.aboveInputTokens ? lc : model.price;
}

export function findModel(
  catalog: Catalog,
  provider: ProviderId,
  id: string,
): CatalogModel | undefined {
  return catalog.models.find((m) => m.provider === provider && m.id === id);
}

/** Days since the oldest `verified_on` in the catalog; MM-04 asks to prompt a refresh after 30. */
export function oldestPriceAgeDays(catalog: Catalog, today: Date = new Date()): number {
  const oldest = [...catalog.models, ...catalog.toolPrices]
    .map((m) => Date.parse(m.verifiedOn))
    .reduce((a, b) => Math.min(a, b));
  return Math.floor((today.getTime() - oldest) / 86_400_000);
}
