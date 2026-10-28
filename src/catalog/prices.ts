/**
 * The price list as data you can change (MM-04): the shipped `data/models.json`, replaced by a
 * newer copy fetched from the repo when you accept one, with your own price edits on top.
 */
import { parseCatalog, type Catalog, type CatalogModel, type ModelPrice } from "./catalog";

/** The repo's current price list: refreshing prices needs no new release. */
export const PRICES_URL =
  "https://raw.githubusercontent.com/isaacholt-hash/fuse/main/data/models.json";
/** Settings keys: the fetched models.json (raw JSON), and your edits (JSON). */
export const FETCHED_SETTING = "catalog.fetched";
export const EDITS_SETTING = "catalog.price_edits";
/** Prices older than this prompt a refresh. */
export const STALE_DAYS = 30;

/** Your price for one model, in US dollars per 1M tokens, and the day you set it. */
export interface PriceEdit extends ModelPrice {
  editedOn: string;
}
/** Keyed `provider/id`. */
export type PriceEdits = Record<string, PriceEdit>;

export const modelKey = (m: Pick<CatalogModel, "provider" | "id">) => `${m.provider}/${m.id}`;

export function parseEdits(raw: string | null): PriceEdits {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as PriceEdits) : {};
  } catch {
    return {};
  }
}

/** The fetched list if it parses and is newer than the shipped one, else the shipped one. */
export function baseCatalog(shipped: Catalog, fetched: string | null): Catalog {
  if (!fetched) return shipped;
  try {
    const parsed = parseCatalog(JSON.parse(fetched));
    return parsed.priceVersion > shipped.priceVersion ? parsed : shipped;
  } catch {
    return shipped;
  }
}

/** Your edits on top; an edited price counts as verified on the day you set it. */
export function applyEdits(base: Catalog, edits: PriceEdits): Catalog {
  const keys = Object.keys(edits);
  if (keys.length === 0) return base;
  const days = keys.map((k) => edits[k]?.editedOn ?? "").sort();
  return {
    ...base,
    priceVersion: `${base.priceVersion}+edits-${days.at(-1) ?? ""}`,
    models: base.models.map((m) => {
      const edit = edits[modelKey(m)];
      if (!edit) return m;
      const { editedOn, ...price } = edit;
      return { ...m, price, verifiedOn: editedOn };
    }),
  };
}

/** Days since the oldest price was checked. */
export function oldestPriceDays(catalog: Catalog, now: number): number {
  const oldest = catalog.models.map((m) => m.verifiedOn).sort()[0];
  if (!oldest) return 0;
  return Math.floor((now - Date.parse(`${oldest}T00:00:00Z`)) / 86_400_000);
}

export interface PriceChange {
  name: string;
  /** e.g. "input $2 → $2.50", "new model", "removed" */
  change: string;
}

const PRICE_FIELDS: { key: keyof ModelPrice; label: string }[] = [
  { key: "input", label: "input" },
  { key: "output", label: "output" },
  { key: "cachedInput", label: "cached input" },
  { key: "cacheWrite", label: "cache write" },
];

const usd = (n: number | undefined) => (n === undefined ? "none" : `$${String(n)}`);

/** What moving from one price list to another changes, model by model. */
export function diffPrices(from: Catalog, to: Catalog): PriceChange[] {
  const out: PriceChange[] = [];
  const before = new Map(from.models.map((m) => [modelKey(m), m]));
  for (const m of to.models) {
    const old = before.get(modelKey(m));
    before.delete(modelKey(m));
    if (!old) {
      out.push({ name: m.displayName, change: "new model" });
      continue;
    }
    const changed = PRICE_FIELDS.filter((f) => old.price[f.key] !== m.price[f.key]).map(
      (f) => `${f.label} ${usd(old.price[f.key])} → ${usd(m.price[f.key])}`,
    );
    if (changed.length > 0) out.push({ name: m.displayName, change: changed.join(", ") });
  }
  for (const m of before.values()) out.push({ name: m.displayName, change: "removed" });
  return out;
}
