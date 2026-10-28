// Housekeeping calls: small jobs FUSE runs for itself (memory suggestions, chat titles) on a cheap
// model. Never shown to the user as an answer (RT-17); every call is logged like any other.
import { priceFor, type Catalog, type CatalogModel, type ProviderId } from "@/catalog/catalog";
import { cost } from "@/cost/cost";
import { ProviderError, userMessage } from "@/providers/errors";
import type { ProviderAdapter, StreamDone } from "@/providers/types";
import { tierModels, type HousekeepingPurpose, type RoutingPolicy } from "@/routing/policy";
import type { Tenant } from "@/storage/defaults";
import { logRequest, type RequestPurpose } from "@/storage/requestLog";
import type { SqlDb } from "@/storage/sql";
import { EMPTY_USAGE, type Usage } from "@/storage/usage";

const PROVIDER_NAMES: Record<ProviderId, string> = { anthropic: "Anthropic", openai: "OpenAI" };

/**
 * The model that does housekeeping: the cheapest model in the purpose's tier (Cheap in
 * data/routing.json) from a provider with a saved key, the chat's provider first on a tie.
 */
export function housekeepingModel(
  policy: RoutingPolicy,
  catalog: Catalog,
  purpose: HousekeepingPurpose,
  providers: readonly ProviderId[],
  prefer?: ProviderId,
): CatalogModel | null {
  const opts = prefer ? { providers, prefer } : { providers };
  return tierModels(policy, catalog, policy.housekeeping[purpose], opts)[0] ?? null;
}

export interface HousekeepingDeps {
  db: SqlDb;
  tenant: Tenant;
  adapterFor: (provider: ProviderId) => ProviderAdapter;
  now?: () => number;
}

export interface HousekeepingRequest {
  purpose: RequestPurpose;
  threadId: string;
  model: CatalogModel;
  system: string;
  input: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export type HousekeepingResult =
  { ok: true; text: string; costMicroUsd: number } | { ok: false; error: string };

/** One non-streamed request: collects the reply, prices it and writes the request_log row. */
export async function housekeepingCall(
  deps: HousekeepingDeps,
  catalog: Catalog,
  req: HousekeepingRequest,
): Promise<HousekeepingResult> {
  const { db, tenant } = deps;
  const { model } = req;
  const now = deps.now ?? Date.now;
  const started = now();
  let text = "";
  let done: StreamDone | null = null;
  let failure: ProviderError | null = null;
  try {
    const stream = deps
      .adapterFor(model.provider)
      .streamChat(
        [{ role: "user", content: req.input }],
        model.id,
        { system: req.system, maxOutputTokens: req.maxOutputTokens },
        req.signal,
      );
    for await (const ev of stream) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "done") done = ev;
    }
  } catch (e) {
    failure =
      e instanceof ProviderError
        ? e
        : new ProviderError("stream", e instanceof Error ? e.message : String(e));
  }

  let usage: Usage = { ...EMPTY_USAGE, latencyMs: now() - started };
  if (done) {
    const t = done.usage;
    const totalInput = t.inputTokens + t.cachedInputTokens + t.cacheWriteTokens;
    usage = {
      ...usage,
      ...t,
      costMicroUsd: done.usageReported ? cost({ ...usage, ...t }, priceFor(model, totalInput)) : 0,
      priceVersion: done.usageReported ? catalog.priceVersion : null,
    };
  }
  await logRequest(db, tenant, {
    threadId: req.threadId,
    messageId: null,
    purpose: req.purpose,
    provider: model.provider,
    model: model.id,
    attempt: done?.attempts ?? 1,
    usage,
    httpStatus: failure?.status ?? (done ? 200 : null),
    errorCode: failure ? (failure.code ?? failure.kind) : null,
    errorMessage: failure ? failure.message.slice(0, 500) : null,
    providerRequestId: done?.providerRequestId ?? failure?.providerRequestId ?? null,
  });
  if (!done) {
    return {
      ok: false,
      error: failure
        ? userMessage(failure, PROVIDER_NAMES[model.provider])
        : "No reply from the model",
    };
  }
  return { ok: true, text, costMicroUsd: usage.costMicroUsd };
}
