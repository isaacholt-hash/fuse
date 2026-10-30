// Housekeeping calls: small jobs FUSE runs for itself (memory suggestions, chat titles) on a cheap
// model. Never shown to the user as an answer (RT-17); every call is logged like any other. With
// a local model installed (M7, LL-04), it goes first and the cloud Cheap model is the one
// fallback.
import { ceilings, clipToTokens } from "@/context/ceilings";
import { threadScope } from "@/providers/types";
import { egressRefusal, threadPolicy } from "@/context/egress";
import { priceFor, type Catalog, type CatalogModel, type ProviderId } from "@/catalog/catalog";
import { cost } from "@/cost/cost";
import { ProviderError, userMessage } from "@/providers/errors";
import type { ProviderAdapter, StreamDone } from "@/providers/types";
import { tierModels, type HousekeepingPurpose, type RoutingPolicy } from "@/routing/policy";
import type { Tenant } from "@/storage/defaults";
import { logRequest, type RequestPurpose } from "@/storage/requestLog";
import type { SqlDb } from "@/storage/sql";
import type { ShadowRecord } from "@/storage/localShadow";
import { EMPTY_USAGE, type Usage } from "@/storage/usage";

const PROVIDER_NAMES: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  local: "the local model",
};

/**
 * The model that does housekeeping: the cheapest model in the purpose's tier (Cheap in
 * data/routing.json) from a provider with a saved key, the chat's provider first on a tie. With
 * no cloud model, the local one (when installed and on) does it alone.
 */
export function housekeepingModel(
  policy: RoutingPolicy,
  catalog: Catalog,
  purpose: HousekeepingPurpose,
  providers: readonly ProviderId[],
  prefer?: ProviderId,
  local: CatalogModel | null = null,
): CatalogModel | null {
  const opts = prefer ? { providers, prefer } : { providers };
  return tierModels(policy, catalog, policy.housekeeping[purpose], opts)[0] ?? local;
}

export interface HousekeepingDeps {
  db: SqlDb;
  tenant: Tenant;
  adapterFor: (provider: ProviderId) => ProviderAdapter;
  /** LL-04: the installed local model, tried before the request's cloud model; null when off. */
  local?: CatalogModel | null;
  /**
   * LL-09: shadow checks. With probability `rate`, a job the local model did also runs on the
   * cloud model, and `record` keeps the timings and whether they agreed (never the text).
   */
  shadow?: { rate: number; record: (r: ShadowRecord) => Promise<void>; random?: () => number };
  now?: () => number;
}

export interface HousekeepingRequest {
  purpose: RequestPurpose;
  /** Null before the chat is saved (the classifier runs before the first message is). */
  threadId: string | null;
  model: CatalogModel;
  system: string;
  input: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export type HousekeepingResult =
  | { ok: true; text: string; costMicroUsd: number; ms?: number; provider?: ProviderId }
  | { ok: false; error: string };

/** Replies compared for a shadow check: spacing and case don't count. */
const normal = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * One housekeeping request (LL-04): on the local model first when it's installed and the
 * project allows it, then once on the request's cloud model if that fails. No retry loops:
 * at most two attempts, each logged.
 */
export async function housekeepingCall(
  deps: HousekeepingDeps,
  catalog: Catalog,
  req: HousekeepingRequest,
): Promise<HousekeepingResult> {
  const local = deps.local;
  if (!local || req.model.provider === "local") return attempt(deps, catalog, req);
  const policy = await threadPolicy(deps.db, deps.tenant, req.threadId);
  if (egressRefusal(policy, "local", "housekeeping")) return attempt(deps, catalog, req);
  const first = await attempt(deps, catalog, { ...req, model: local });
  if (first.ok) {
    const shadow = deps.shadow;
    if (shadow && shadow.rate > 0 && (shadow.random ?? Math.random)() < shadow.rate) {
      // In the background: the job is done, this only measures it.
      void attempt(deps, catalog, req)
        .then((cloud) =>
          cloud.ok
            ? shadow.record({
                purpose: req.purpose,
                localModel: local.id,
                cloudModel: `${req.model.provider}/${req.model.id}`,
                localMs: first.ms ?? 0,
                cloudMs: cloud.ms ?? 0,
                localChars: first.text.length,
                cloudChars: cloud.text.length,
                same: normal(first.text) === normal(cloud.text),
              })
            : undefined,
        )
        .catch(() => undefined);
    }
    return first;
  }
  if (req.signal?.aborted) return first;
  return attempt(deps, catalog, req);
}

/** One non-streamed request: collects the reply, prices it and writes the request_log row. */
async function attempt(
  deps: HousekeepingDeps,
  catalog: Catalog,
  req: HousekeepingRequest,
): Promise<HousekeepingResult> {
  const { db, tenant } = deps;
  const { model } = req;
  // SE-13: titles, summaries, memory suggestions and second opinions obey the policy too.
  const refused = egressRefusal(
    await threadPolicy(db, tenant, req.threadId),
    model.provider,
    "housekeeping",
  );
  if (refused) return { ok: false, error: refused };
  const now = deps.now ?? Date.now;
  const started = now();
  let text = "";
  let done: StreamDone | null = null;
  let failure: ProviderError | null = null;
  // LL-05: housekeeping input has a ceiling; the local model's is smaller (a 4,096-token context).
  const input = clipToTokens(
    req.input,
    model.provider === "local" ? ceilings.localInputTokens : ceilings.housekeepingInputTokens,
  );
  try {
    const stream = deps.adapterFor(model.provider).streamChat(
      [{ role: "user", content: input }],
      model.id,
      {
        system: req.system,
        maxOutputTokens: req.maxOutputTokens,
        scope: threadScope(req.threadId),
      },
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
  return {
    ok: true,
    text,
    costMicroUsd: usage.costMicroUsd,
    ms: usage.latencyMs ?? 0,
    provider: model.provider,
  };
}
