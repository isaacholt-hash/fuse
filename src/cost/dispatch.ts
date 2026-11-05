/** One bounded, accounted run request. Never retries a possibly billed dispatch. */
import type { Catalog, CatalogModel } from "@/catalog/catalog";
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

/** UTF-8 byte upper bound for text, with framing headroom; opaque media uses the full window. */
export function requestBound(
  model: CatalogModel,
  messages: ChatMessage[],
  options: ChatOptions,
): number {
  if (model.provider === "local") return 0;
  const media = messages.some(
    (m) =>
      m.attachments?.some((a) => a.kind !== "text") || m.toolResults?.some((t) => t.images?.length),
  );
  const input = media
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
  const value =
    (BigInt(input) * BigInt(priceToMicro(rateIn)) +
      BigInt(output) * BigInt(priceToMicro(rateOut)) +
      999_999n) /
    1_000_000n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Request cost bound overflow.");
  return Number(value);
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
    Pick<RequestLogEntry, "tier">,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const id = uuidv7();
  // Keep a single tool turn bounded; long work uses the existing multi-turn loop.
  const bounded = {
    ...options,
    maxOutputTokens: Math.min(options.maxOutputTokens ?? model.maxOutput, 4000),
    noRetry: true,
  };
  if (bounded.webSearch) throw new Error("Search requests need an explicit tool-cost bound.");
  const boundMicroUsd = requestBound(model, messages, bounded);
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
      "Paused before the next request would exceed its cost cap. Continue with a higher cap.",
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
    let charged = 0;
    try {
      if (reported && tokens) {
        const totalInput = tokens.inputTokens + tokens.cachedInputTokens + tokens.cacheWriteTokens;
        charged = cost({ ...EMPTY_USAGE, ...tokens }, priceFor(model, totalInput));
      }
    } catch {
      tokens = undefined;
      reported = false;
      failure = new ProviderError("stream", "Invalid provider usage; billing is unresolved.");
    }
    const billingState = reported
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
  yield { ...done, requestLogId: id };
}
