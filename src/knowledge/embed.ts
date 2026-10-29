/**
 * Embeddings (MM-11): the embedding model, and indexing chunks with it. Every call is logged as
 * `purpose: embed` with its cost, like any other provider call.
 */
import { egressRefusal, threadPolicy } from "@/context/egress";
import type { Catalog, EmbeddingModel, ProviderId } from "@/catalog/catalog";
import { priceToMicro } from "@/cost/cost";
import { ProviderError, userMessage } from "@/providers/errors";
import type { ProviderAdapter } from "@/providers/types";
import type { Tenant } from "@/storage/defaults";
import { logRequest } from "@/storage/requestLog";
import type { SqlDb } from "@/storage/sql";
import { EMPTY_USAGE } from "@/storage/usage";
import { saveVectors, unembedded, type ChunkSource } from "@/storage/vectors";

/** Most inputs and tokens per embeddings request (OpenAI allows more; this keeps calls small). */
const BATCH_INPUTS = 64;
const BATCH_TOKENS = 60_000;

export interface EmbedDeps {
  db: SqlDb;
  tenant: Tenant;
  /** Stamped on the logged cost, like every priced row. */
  priceVersion: string;
  adapterFor: (provider: ProviderId) => ProviderAdapter;
  now?: () => number;
}

/** The embedding model to use: the cheapest one from a provider with a key (decided M2 step 13). */
export function embeddingModel(
  catalog: Catalog,
  providers: readonly ProviderId[],
): EmbeddingModel | null {
  return (
    [...catalog.embeddingModels]
      .filter((m) => providers.includes(m.provider))
      .sort((a, b) => a.inputPrice - b.inputPrice)[0] ?? null
  );
}

/** The key chunk vectors are stored under: "openai/text-embedding-3-small". */
export const modelKey = (m: EmbeddingModel) => `${m.provider}/${m.id}`;

/** Embeds texts in one logged call. */
export async function embedTexts(
  deps: EmbedDeps,
  model: EmbeddingModel,
  texts: string[],
  threadId: string | null = null,
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  // SE-13: a chat's project may forbid sending its content to be embedded.
  const refused = egressRefusal(
    await threadPolicy(deps.db, deps.tenant, threadId),
    model.provider,
    "embeddings",
  );
  if (refused) throw new Error(refused);
  const adapter = deps.adapterFor(model.provider);
  if (!adapter.embed) throw new Error(`${model.provider} has no embeddings`);
  const now = deps.now ?? Date.now;
  const started = now();
  try {
    const r = await adapter.embed(texts, model.id, signal);
    await logRequest(deps.db, deps.tenant, {
      threadId,
      messageId: null,
      purpose: "embed",
      provider: model.provider,
      model: model.id,
      attempt: r.attempts,
      usage: {
        ...EMPTY_USAGE,
        inputTokens: r.tokens,
        costMicroUsd: Math.round((r.tokens * priceToMicro(model.inputPrice)) / 1_000_000),
        priceVersion: deps.priceVersion,
        latencyMs: now() - started,
      },
      httpStatus: 200,
      errorCode: null,
      errorMessage: null,
      providerRequestId: r.providerRequestId,
    });
    return r.vectors;
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError("network", String(e));
    await logRequest(deps.db, deps.tenant, {
      threadId,
      messageId: null,
      purpose: "embed",
      provider: model.provider,
      model: model.id,
      attempt: 1,
      usage: { ...EMPTY_USAGE, latencyMs: now() - started },
      httpStatus: err.status,
      errorCode: err.code ?? err.kind,
      errorMessage: err.message.slice(0, 500),
      providerRequestId: err.providerRequestId,
    });
    throw new Error(userMessage(err, model.provider === "openai" ? "OpenAI" : "Anthropic"), {
      cause: e,
    });
  }
}

/** Embeds every chunk of these sources that has no vector yet. Returns how many were embedded. */
export async function indexChunks(
  deps: EmbedDeps,
  model: EmbeddingModel,
  kind: ChunkSource,
  sourceIds: readonly string[],
  signal?: AbortSignal,
): Promise<number> {
  const todo = await unembedded(deps.db, deps.tenant, modelKey(model), kind, sourceIds);
  let done = 0;
  while (done < todo.length) {
    const batch = [];
    let tokens = 0;
    for (const c of todo.slice(done)) {
      if (batch.length >= BATCH_INPUTS || (batch.length > 0 && tokens + c.tokens > BATCH_TOKENS)) {
        break;
      }
      batch.push(c);
      tokens += c.tokens;
    }
    const vectors = await embedTexts(
      deps,
      model,
      batch.map((c) => c.text),
      null,
      signal,
    );
    await saveVectors(
      deps.db,
      deps.tenant,
      modelKey(model),
      batch.map((c, i) => ({ chunkId: c.id, vector: vectors[i] ?? new Float32Array() })),
    );
    done += batch.length;
  }
  return done;
}
