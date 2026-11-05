/** Research uses the shared router and quality floors, with an explicit cost-bound filter. */
import type { Catalog, CatalogModel, ProviderId } from "@/catalog/catalog";
import config from "../../data/research.json";
import { cost, priceToMicro } from "@/cost/cost";
import { priceFor } from "@/catalog/catalog";
import { EMPTY_USAGE } from "@/storage/usage";
import { requestBound } from "@/cost/dispatch";
import { classify } from "@/routing/classify";
import { routeForRun, type RouteMode } from "@/routing/route";
import { tierOf, type RoutingPolicy } from "@/routing/policy";

export interface ResearchModels {
  worker: CatalogModel;
  best: CatalogModel;
  pinned: boolean;
  /** Conservative per-search reservation, not a prediction of the final bill. */
  searchBoundMicroUsd: number;
  firstBoundMicroUsd: number;
  reason: string;
  estimatedMicroUsd: number;
}
export function searchBound(catalog: Catalog, model: CatalogModel): number {
  if (model.provider === "local" || !model.capabilities.includes("web_search"))
    throw new Error(
      "Research needs an eligible cloud search model. Local models only do housekeeping.",
    );
  return requestBound(
    model,
    [],
    { webSearch: true, searchBounds: { maxUses: 1 }, maxOutputTokens: 4000 },
    catalog.toolPrices,
  );
}
export function researchModels(
  catalog: Catalog,
  policy: RoutingPolicy,
  mode: RouteMode,
  task: string,
  providers: readonly ProviderId[],
): ResearchModels {
  const eligible = new Set(
    catalog.models
      .filter((model) => {
        try {
          searchBound(catalog, model);
          return true;
        } catch {
          return false;
        }
      })
      .map((model) => `${model.provider}/${model.id}`),
  );
  // Keep every Best text model available for planning/synthesis; only search capability is filtered.
  const boundedCatalog: Catalog = {
    ...catalog,
    models: catalog.models.map((model) =>
      eligible.has(`${model.provider}/${model.id}`)
        ? model
        : {
            ...model,
            capabilities: model.capabilities.filter((capability) => capability !== "web_search"),
          },
    ),
  };
  const result = routeForRun(
    policy,
    boundedCatalog,
    mode,
    classify({ text: task, webSearch: true }),
    { providers: providers.filter((provider) => provider !== "local") },
  );
  if (!result.ok) throw new Error(result.error);
  const worker = catalog.models.find(
    (model) => model.id === result.model.id && model.provider === result.model.provider,
  );
  if (!worker || tierOf(policy, worker) === "cheap")
    throw new Error("Cheap models remain restricted to housekeeping.");
  if (!providers.includes(worker.provider))
    throw new Error(
      "The selected research model needs its existing provider connection on this execution owner.",
    );
  const bound = searchBound(catalog, worker);
  const best = mode.kind === "auto" ? result.info.best : worker;
  if (!best || best.provider === "local" || !providers.includes(best.provider))
    throw new Error("Research needs an available Best model for planning and synthesis.");
  const usage = {
    ...EMPTY_USAGE,
    inputTokens: config.estimate.input_tokens,
    outputTokens: config.estimate.output_tokens,
  };
  const fee = catalog.toolPrices.find((price) => price.provider === worker.provider)?.usdPerCall;
  if (fee === undefined) throw new Error("Research needs current search pricing.");
  const estimatedMicroUsd =
    config.estimate.searches *
      (cost(usage, priceFor(worker, usage.inputTokens)) + priceToMicro(fee)) +
    config.estimate.text_calls * cost(usage, priceFor(best, usage.inputTokens));
  return {
    estimatedMicroUsd,
    worker,
    best,
    pinned: mode.kind !== "auto",
    searchBoundMicroUsd: bound,
    firstBoundMicroUsd: requestBound(
      best,
      [{ role: "user", content: task }],
      { maxOutputTokens: 4000 },
      catalog.toolPrices,
    ),
    reason: result.info.reason,
  };
}
