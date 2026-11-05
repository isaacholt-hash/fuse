/** Bounded context retrieval uses the existing ledger/holds and exactly one provider attempt. */
import type { EmbeddingModel } from "@/catalog/catalog";
import { ProviderError } from "@/providers/errors";
import {
  threadScope,
  type EmbedResult,
  type ProviderAdapter,
  type SendScope,
} from "@/providers/types";
import type { Tenant } from "@/storage/defaults";
import { uuidv7 } from "@/storage/ids";
import {
  reserveRequest,
  dispatchRequest,
  releaseRequest,
  settleRequest,
} from "@/storage/requestBudget";
import type { SqlDb } from "@/storage/sql";
import { EMPTY_USAGE } from "@/storage/usage";
import { priceToMicro } from "./cost";
import { noBill } from "./dispatch";

export interface EmbeddingContext {
  runId: string | null;
  threadId: string | null;
  messageId: string | null;
  projectId?: string | null;
}

export function embeddingBound(model: EmbeddingModel, texts: readonly string[]): number {
  const rate = priceToMicro(model.inputPrice);
  if (
    model.provider === "local" ||
    !Number.isSafeInteger(model.maxInputTokens) ||
    model.maxInputTokens <= 0 ||
    !Number.isSafeInteger(model.dimensions) ||
    model.dimensions <= 0 ||
    model.dimensions > 8192 ||
    !Number.isFinite(model.inputPrice) ||
    model.inputPrice < 0 ||
    !Number.isSafeInteger(rate) ||
    (model.inputPrice > 0 && rate === 0) ||
    texts.length === 0 ||
    texts.length > 32 ||
    texts.some(
      (text) =>
        !text.trim() ||
        new TextEncoder().encode(text).length > Math.min(model.maxInputTokens, 4000),
    )
  )
    throw new ProviderError(
      "invalid_request",
      "Meaning retrieval requires bounded text and a priced cloud embedding model.",
    );
  // Reserve the catalog's full per-input allowance, even though each supplied text is smaller.
  const value =
    (BigInt(model.maxInputTokens) * BigInt(texts.length) * BigInt(rate) + 999_999n) / 1_000_000n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Embedding cost bound overflow.");
  return Number(value);
}

export async function trackedEmbedding(
  deps: { db: SqlDb; tenant: Tenant; priceVersion: string },
  adapter: ProviderAdapter,
  model: EmbeddingModel,
  texts: string[],
  context: EmbeddingContext,
  signal?: AbortSignal,
  scope: SendScope = threadScope(context.threadId),
): Promise<EmbedResult & { requestLogId: string }> {
  if (!adapter.embed || adapter.provider !== model.provider)
    throw new ProviderError("unavailable", "This embedding connection is unavailable.");
  const boundMicroUsd = embeddingBound(model, texts);
  const id = uuidv7();
  if (
    !(await reserveRequest(deps.db, deps.tenant, {
      ...context,
      id,
      provider: model.provider,
      model: model.id,
      purpose: "embed",
      boundMicroUsd,
    }))
  )
    throw new ProviderError(
      "billing",
      "Meaning retrieval was paused before exceeding the combined cap or budget.",
      { code: "request_cap" },
    );
  if (signal?.aborted || !(await dispatchRequest(deps.db, deps.tenant, id))) {
    await releaseRequest(deps.db, deps.tenant, id);
    throw new ProviderError("aborted", "Meaning retrieval stopped before dispatch.");
  }
  const started = Date.now();
  let result: EmbedResult | null = null;
  let failure: ProviderError | null = null;
  let reported = false;
  try {
    result = await adapter.embed(texts, model.id, signal, scope, { noRetry: true });
    reported =
      result.usageReported !== false && Number.isSafeInteger(result.tokens) && result.tokens >= 0;
    if (reported && BigInt(result.tokens) > BigInt(model.maxInputTokens) * BigInt(texts.length))
      reported = false;
    if (
      result.attempts !== 1 ||
      result.vectors.length !== texts.length ||
      result.vectors.some(
        (vector) => vector.length !== model.dimensions || !vector.every(Number.isFinite),
      )
    )
      throw new ProviderError(
        "stream",
        "The embedding response contained malformed vectors or attempt metadata.",
      );
  } catch (error) {
    failure =
      error instanceof ProviderError
        ? error
        : new ProviderError(
            signal?.aborted ? "aborted" : "network",
            "Meaning retrieval was interrupted.",
          );
  } finally {
    if (result?.attempts !== 1) reported = false;
    const billingState = reported
      ? "reported"
      : failure && noBill(failure)
        ? "not_billed"
        : "unknown";
    await settleRequest(deps.db, deps.tenant, id, {
      ...context,
      purpose: "embed",
      provider: model.provider,
      model: model.id,
      attempt: 1,
      usage: {
        ...EMPTY_USAGE,
        inputTokens: reported && result ? result.tokens : 0,
        costMicroUsd:
          reported && result
            ? Number(
                (BigInt(result.tokens) * BigInt(priceToMicro(model.inputPrice)) + 500_000n) /
                  1_000_000n,
              )
            : 0,
        priceVersion: reported ? deps.priceVersion : null,
        latencyMs: Date.now() - started,
      },
      billingState,
      httpStatus: failure?.status ?? (result ? 200 : null),
      errorCode: failure?.code ?? failure?.kind ?? (reported ? null : "missing_usage"),
      errorMessage: failure
        ? `Embedding request failed (${failure.kind}).`
        : reported
          ? null
          : "Embedding billing is unresolved.",
      providerRequestId: result?.providerRequestId ?? failure?.providerRequestId ?? null,
    });
    if (failure) {
      failure.requestLogId = id;
      failure.billingUncertain = billingState === "unknown";
    }
  }
  if (failure) throw failure;
  if (!result) throw new Error("No embedding result was retained.");
  return { ...result, usageReported: reported, requestLogId: id };
}
