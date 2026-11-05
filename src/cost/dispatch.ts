/** One bounded, accounted run request. Never retries a possibly billed dispatch. */
import type { Catalog, CatalogModel, ToolPrice } from "@/catalog/catalog";
import { priceFor } from "@/catalog/catalog";
import { ProviderError } from "@/providers/errors";
import type {
  ChatMessage,
  ChatOptions,
  ProviderAdapter,
  StreamDone,
  StreamEvent,
} from "@/providers/types";
import type { RequestLogEntry } from "@/storage/requestLog";
import type { Tenant } from "@/storage/defaults";
import { uuidv7 } from "@/storage/ids";
import {
  dispatchRequest,
  reserveRequest,
  releaseRequest,
  settleRequest,
  type Reservation,
} from "@/storage/requestBudget";
import type { SqlDb } from "@/storage/sql";
import { EMPTY_USAGE } from "@/storage/usage";
import { cost, priceToMicro } from "./cost";
import { searchUses, searchConfig, reportedSearchCount } from "@/providers/search";

/** UTF-8 byte upper bound for text, with framing headroom; opaque media uses the full window. */
export function requestBound(
  model: CatalogModel,
  messages: ChatMessage[],
  options: ChatOptions,
  toolPrices: readonly ToolPrice[] = [],
): number {
  if (model.provider === "local") {
    if (options.webSearch)
      throw new Error("Local models are restricted to housekeeping and cannot search.");
    return 0;
  }
  const media = messages.some(
    (m) =>
      m.attachments?.some((a) => a.kind !== "text") || m.toolResults?.some((t) => t.images?.length),
  );
  const uses = searchUses(options);
  if (uses !== null && searchConfig.providers[model.provider].cost_bound === null)
    throw new ProviderError(
      "invalid_request",
      "This provider does not document a conservative hosted-search cost bound. Choose an eligible search model; non-search planning and synthesis remain available.",
    );
  const fee = uses === null ? 0 : searchFee(model, toolPrices);
  const input =
    uses !== null
      ? model.provider === "openai"
        ? Math.min(model.contextWindow, searchConfig.providers.openai.context_tokens)
        : model.contextWindow
      : media
        ? model.contextWindow
        : Math.min(
            model.contextWindow,
            new TextEncoder().encode(
              JSON.stringify({ messages, system: options.system, tools: options.tools }),
            ).length + 8192,
          );
  const output = Math.min(model.maxOutput, options.maxOutputTokens ?? model.maxOutput);
  const prices = [model.price, ...(model.longContextPrice ? [model.longContextPrice] : [])];
  const rateIn = Math.max(
    ...prices.flatMap((p) => [p.input, p.cachedInput ?? p.input, p.cacheWrite ?? p.input]),
  );
  const rateOut = Math.max(...prices.map((p) => p.output));
  // Hosted search may run multiple inference iterations. Reserve a full context/output
  // for each possible iteration, including separately billed cache writes and long context.
  const iterations = BigInt((uses ?? 0) + 1);
  const value =
    ((BigInt(input) * BigInt(priceToMicro(rateIn)) +
      BigInt(output) * BigInt(priceToMicro(rateOut))) *
      iterations +
      999_999n) /
      1_000_000n +
    BigInt(uses ?? 0) * BigInt(fee);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Request cost bound overflow.");
  return Number(value);
}

function searchFee(model: CatalogModel, prices: readonly ToolPrice[]): number {
  const fee = prices.find((p) => p.provider === model.provider)?.usdPerCall;
  if (
    fee === undefined ||
    !Number.isFinite(fee) ||
    fee < 0 ||
    !Number.isSafeInteger(priceToMicro(fee))
  )
    throw new Error("Search needs a verified per-call price before dispatch.");
  return priceToMicro(fee);
}

function validCharge(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid request cost.");
  return value;
}
function searchCharge(model: CatalogModel, prices: readonly ToolPrice[], raw: unknown): number {
  const count = reportedSearchCount(raw);
  if (count === null) throw new Error("Invalid search usage.");
  return validCharge(searchFee(model, prices) * count);
}

export const noBill = (e: ProviderError): boolean =>
  e.kind === "blocked" ||
  ["no_key", "keychain", "forbidden"].includes(e.code ?? "") ||
  (e.status !== null && [400, 401, 402, 403, 404, 413, 422, 429].includes(e.status));

export async function* trackedChat(
  deps: { db: SqlDb; tenant: Tenant; catalog: Catalog },
  adapter: ProviderAdapter,
  model: CatalogModel,
  messages: ChatMessage[],
  options: ChatOptions,
  context: Omit<Reservation, "id" | "boundMicroUsd" | "provider" | "model"> &
    Pick<RequestLogEntry, "tier"> & { attemptId?: string },
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const id = context.attemptId ?? uuidv7();
  // Keep a single tool turn bounded; long work uses the existing multi-turn loop.
  const bounded = {
    ...options,
    maxOutputTokens: Math.min(options.maxOutputTokens ?? model.maxOutput, 4000),
    noRetry: true,
  };
  const boundMicroUsd = requestBound(model, messages, bounded, deps.catalog.toolPrices);
  if (
    !(await reserveRequest(deps.db, deps.tenant, {
      ...context,
      id,
      provider: model.provider,
      model: model.id,
      boundMicroUsd,
    }))
  )
    throw new ProviderError(
      "billing",
      "Paused before the next request would exceed the run cap or a project/global budget. Review those limits before explicitly continuing.",
      { code: "request_cap" },
    );
  if (signal?.aborted) {
    await releaseRequest(deps.db, deps.tenant, id);
    throw new ProviderError("aborted", "Stopped before dispatch.");
  }
  if (!(await dispatchRequest(deps.db, deps.tenant, id))) {
    await releaseRequest(deps.db, deps.tenant, id);
    throw new ProviderError("aborted", "Stopped before dispatch.");
  }
  const started = Date.now();
  let done: StreamDone | null = null;
  let failure: ProviderError | null = null;
  try {
    for await (const event of adapter.streamChat(messages, model.id, bounded, signal)) {
      if (event.type === "done") {
        done = event;
        break;
      }
      yield event;
    }
  } catch (error) {
    failure =
      error instanceof ProviderError
        ? error
        : new ProviderError(
            signal?.aborted ? "aborted" : "network",
            "The request was interrupted.",
          );
  } finally {
    let tokens = done?.usage;
    let reported = done?.usageReported === true;
    let complete = reported && (!bounded.webSearch || done?.searchUsageReported === true);
    let charged = 0;
    try {
      if (reported && tokens) {
        const totalInput = tokens.inputTokens + tokens.cachedInputTokens + tokens.cacheWriteTokens;
        charged = cost({ ...EMPTY_USAGE, ...tokens }, priceFor(model, totalInput));
        if (bounded.webSearch) {
          const tools = searchCharge(model, deps.catalog.toolPrices, tokens.webSearchCalls);
          if (done?.searchUsageReported === true) charged += tools;
        }
        charged = validCharge(charged);
      }
    } catch {
      tokens = undefined;
      if (!Number.isSafeInteger(charged) || charged < 0) charged = 0;
      reported = false;
      complete = false;
      failure = new ProviderError("stream", "Invalid provider usage; billing is unresolved.");
    }
    const billingState = complete
      ? "reported"
      : failure && noBill(failure)
        ? "not_billed"
        : "unknown";
    await settleRequest(deps.db, deps.tenant, id, {
      threadId: context.threadId,
      messageId: context.messageId,
      projectId: context.projectId ?? null,
      purpose: context.purpose,
      tier: context.tier,
      provider: model.provider,
      model: model.id,
      attempt: 1,
      usage: {
        ...EMPTY_USAGE,
        ...(tokens ?? {}),
        costMicroUsd: charged,
        priceVersion: reported ? deps.catalog.priceVersion : null,
        latencyMs: Date.now() - started,
      },
      billingState,
      httpStatus: failure?.status ?? (done ? 200 : null),
      errorCode: failure?.code ?? failure?.kind ?? (done ? null : "interrupted"),
      // The original error may include returned prompt text. Persist only its fixed classification.
      errorMessage: failure ? `Provider request failed (${failure.kind}).` : null,
      providerRequestId: done?.providerRequestId ?? failure?.providerRequestId ?? null,
    });
  }
  if (failure) {
    failure.requestLogId = id;
    throw failure;
  }
  if (!done) {
    const error = new ProviderError(
      "stream",
      "The request ended without usage; billing is unresolved.",
    );
    error.requestLogId = id;
    throw error;
  }
  yield {
    ...done,
    usageReported: done.usageReported && (!bounded.webSearch || done.searchUsageReported === true),
    requestLogId: id,
  };
}
