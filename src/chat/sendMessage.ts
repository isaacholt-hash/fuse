import {
  priceFor,
  toolPrice,
  type Catalog,
  type CatalogModel,
  type EmbeddingModel,
  type ProviderId,
} from "@/catalog/catalog";
import { cost } from "@/cost/cost";
import type { ModelDefaults } from "@/routing/modelDefaults";
import { ProviderError, userMessage } from "@/providers/errors";
import type { FilesApi } from "@/files/api";
import type { ProviderAdapter, StreamDone } from "@/providers/types";
import type { Tenant } from "@/storage/defaults";
import {
  addMessage,
  deleteMessage,
  finishMessage,
  listPath,
  setMessageModel,
  updateMessageContent,
} from "@/storage/messages";
import { addCitations, addFileCitations } from "@/storage/citations";
import { artifactsIn } from "@/artifacts/parse";
import { saveArtifacts } from "@/storage/artifacts";
import { recordInjected } from "@/storage/memories";
import { filesForMessages, linkFiles, type FileMode } from "@/storage/files";
import { logRequest } from "@/storage/requestLog";
import type { SqlDb } from "@/storage/sql";
import { getThread, renameThread, setActiveLeaf } from "@/storage/threads";
import { EMPTY_USAGE, type Usage } from "@/storage/usage";
import type { RouteInfo } from "@/routing/route";
import { assemble } from "@/context/assemble";
import { gatherContext, type Context } from "@/context/gather";
import { egressRefusal, threadPolicy } from "@/context/egress";

/** The history sent to a model (PM-18 gathers it in `src/context/gather.ts`). */
export { historyFor } from "@/context/gather";

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

export interface ChatDeps {
  db: SqlDb;
  tenant: Tenant;
  catalog: Catalog;
  adapterFor: (provider: ProviderId) => ProviderAdapter;
  /** Where attachment bytes live; needed once a thread has attachments. */
  files?: FilesApi;
  /** How often streamed text is saved while the answer is still coming in. */
  saveEveryMs?: number;
  now?: () => number;
}

export interface SendInput {
  threadId: string;
  model: CatalogModel;
  text: string;
  /** Files already stored (src/storage/files.ts addFile) to attach to this question. */
  fileIds?: string[];
  signal?: AbortSignal;
  /** Called with the full answer text so far, for live rendering. */
  onText?: (textSoFar: string) => void;
  /** Allow the model to search the web (only if the model supports it). */
  webSearch?: boolean;
  /** Called when the provider starts ("searching") or finishes (null) a web search. */
  onStatus?: (status: "searching" | null) => void;
  /** Called with the sources cited so far, in first-cited order. */
  onCitations?: (sources: Source[]) => void;
  /** How the model was picked (RT-09); saved with the answer. */
  route?: RouteInfo;
  /** Embeds questions to search large attached files (FK-02); null when there's no OpenAI key. */
  embedding?: EmbeddingModel | null;
  /** How each attached file is sent (FK-03); missing = whole. */
  fileModes?: Partial<Record<string, FileMode>>;
  /**
   * Same tier, other provider (MM-06): answers instead when `model`'s provider fails with a
   * retryable error (after its own retries) before any text arrived.
   */
  fallback?: CatalogModel | null;
  /** MM-07: your defaults for the model that answers (max output, effort, a prompt prefix). */
  defaults?: (model: CatalogModel) => ModelDefaults;
}

export interface Source {
  url: string;
  title: string | null;
}

/** Stop reasons meaning the answer hit a length limit (docs/providers.md). */
const LENGTH_LIMIT_STOPS: ReadonlySet<string> = new Set([
  "max_tokens",
  "model_context_window_exceeded",
  "max_output_tokens",
]);

export interface SendResult {
  userMessageId: string;
  assistantMessageId: string;
  status: "complete" | "stopped" | "error";
  costMicroUsd: number;
  error?: string;
  /** Set when a complete answer hit a length limit (shown next to the answer, not as an error). */
  notice?: string;
  /** The provider that failed before the fallback answered (MM-06). */
  failedOverFrom?: ProviderId;
}

const titleFrom = (text: string, hasFiles: boolean) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 60
    ? `${line.slice(0, 57).trimEnd()}…`
    : line || (hasFiles ? "Image" : "New chat");
};

export async function sendMessage(deps: ChatDeps, input: SendInput): Promise<SendResult> {
  const { db, tenant } = deps;
  const text = input.text.trim();
  const fileIds = input.fileIds ?? [];
  if (!text && fileIds.length === 0) throw new Error("Message is empty");

  const { path: previous } = await listPath(db, tenant, input.threadId);
  const userMessageId = await addQuestion(deps, input.threadId, previous.at(-1)?.id ?? null, text);
  await linkFiles(db, tenant, userMessageId, fileIds, input.fileModes);
  if (previous.length === 0) {
    const thread = await getThread(db, tenant, input.threadId);
    if (thread?.titleSource === "auto") {
      await renameThread(db, tenant, input.threadId, titleFrom(text, fileIds.length > 0), "auto");
    }
  }
  return streamAnswer(
    deps,
    input,
    userMessageId,
    await historyTo(deps, input.threadId, input.embedding),
  );
}

/** Saves a question under `parentId` and makes it the end of the thread's path. */
async function addQuestion(
  deps: ChatDeps,
  threadId: string,
  parentId: string | null,
  text: string,
): Promise<string> {
  const id = await addMessage(deps.db, deps.tenant, {
    threadId,
    parentId,
    role: "user",
    content: text,
  });
  await setActiveLeaf(deps.db, deps.tenant, threadId, id);
  return id;
}

/** The history to send: the thread's path, up to and including `lastId` (default: all of it). */
async function historyTo(
  deps: ChatDeps,
  threadId: string,
  embedding: EmbeddingModel | null | undefined,
  lastId?: string,
): Promise<Context> {
  const { path } = await listPath(deps.db, deps.tenant, threadId);
  const end = lastId === undefined ? path.length : path.findIndex((m) => m.id === lastId) + 1;
  return gatherContext(deps, threadId, path.slice(0, end), embedding);
}

/**
 * Edits a question (CH-04): the new text becomes a sibling of the old question, with its files,
 * and gets a fresh answer. The old question and everything after it stay on their own branch.
 */
export async function editQuestion(
  deps: ChatDeps,
  input: RetryInput & { messageId: string; text: string },
): Promise<SendResult> {
  const { db, tenant } = deps;
  const { path } = await listPath(db, tenant, input.threadId);
  const original = path.find((m) => m.id === input.messageId && m.role === "user");
  if (!original) throw new Error("That question isn't in this chat any more");
  const files = (await filesForMessages(db, tenant, [original.id])).get(original.id) ?? [];
  const text = input.text.trim();
  if (!text && files.length === 0) throw new Error("Message is empty");
  const id = await addQuestion(deps, input.threadId, original.parentId, text);
  await linkFiles(
    db,
    tenant,
    id,
    files.map((f) => f.id),
    Object.fromEntries(files.map((f) => [f.id, f.mode ?? "whole"])),
  );
  return streamAnswer(deps, input, id, await historyTo(deps, input.threadId, input.embedding));
}

/** Answers a question again (CH-04): the new answer is a sibling of the old one. */
export async function regenerate(
  deps: ChatDeps,
  input: RetryInput & { answerId: string },
): Promise<SendResult> {
  const { path } = await listPath(deps.db, deps.tenant, input.threadId);
  const answer = path.find((m) => m.id === input.answerId && m.role === "assistant");
  const question = answer && path.find((m) => m.id === answer.parentId);
  if (!question) throw new Error("That answer isn't in this chat any more");
  return streamAnswer(
    deps,
    input,
    question.id,
    await historyTo(deps, input.threadId, input.embedding, question.id),
  );
}

export type RetryInput = Omit<SendInput, "text" | "fileIds">;

/** The last question, its answers, and the history up to and including that question. */
async function lastTurn(
  deps: ChatDeps,
  threadId: string,
  embedding: EmbeddingModel | null | undefined,
) {
  const { path: messages } = await listPath(deps.db, deps.tenant, threadId);
  const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
  const question = messages[lastUserIndex];
  if (!question) throw new Error("Nothing to retry");
  return {
    question,
    answer: messages.slice(lastUserIndex + 1).findLast((m) => m.role === "assistant"),
    context: await gatherContext(deps, threadId, messages.slice(0, lastUserIndex + 1), embedding),
  };
}

/**
 * Re-asks the last question (after an error or a stop), optionally on another model.
 * The failed or stopped answer is removed so the thread reads cleanly; an answer it was a
 * stronger re-run of stays, and the new one is a re-run of it too.
 */
export async function retryLast(deps: ChatDeps, input: RetryInput): Promise<SendResult> {
  const { question, answer, context } = await lastTurn(deps, input.threadId, input.embedding);
  if (answer) await deleteMessage(deps.db, deps.tenant, answer.id);
  return streamAnswer(deps, input, question.id, context, answer?.escalatedFromId ?? null);
}

/**
 * "Try a stronger model" (RT-04): answers the last question again on `input.model`, keeping the
 * old answer on screen. Later turns send only the new one.
 */
export async function escalateLast(deps: ChatDeps, input: RetryInput): Promise<SendResult> {
  const { question, answer, context } = await lastTurn(deps, input.threadId, input.embedding);
  if (!answer) throw new Error("There's no answer to try again");
  return streamAnswer(deps, input, question.id, context, answer.id);
}

async function streamAnswer(
  deps: ChatDeps,
  input: RetryInput,
  userMessageId: string,
  context: Context,
  escalatedFromId: string | null = null,
): Promise<SendResult> {
  const { db, tenant } = deps;
  let model = input.model;
  const now = deps.now ?? Date.now;
  const saveEvery = deps.saveEveryMs ?? 1000;
  const assistantMessageId = await addMessage(db, tenant, {
    threadId: input.threadId,
    parentId: userMessageId,
    role: "assistant",
    content: "",
    status: "streaming",
    provider: model.provider,
    model: model.id,
    route: input.route
      ? {
          mode: input.route.mode,
          tier: input.route.tier,
          ruleId: input.route.ruleId,
          reason: input.route.reason,
          intent: input.route.intent,
          complexity: input.route.complexity,
        }
      : null,
    escalatedFromId,
  });
  await setActiveLeaf(db, tenant, input.threadId, assistantMessageId);

  // PM-18: one assembler builds every request.
  const { system, history, picked, fileSources } = await assemble(
    deps,
    input.threadId,
    context,
    input.embedding,
  );
  await recordInjected(
    db,
    tenant,
    assistantMessageId,
    picked.map((p) => ({ id: p.memory.id, reason: p.reason, score: p.score })),
  );

  const policy = await threadPolicy(db, tenant, input.threadId);

  /** One provider call, streamed into the answer. */
  const attempt = async (m: CatalogModel) => {
    const started = now();
    let firstTokenAt: number | null = null;
    let answer = "";
    let lastSave = started;
    let done: StreamDone | null = null;
    let failure: ProviderError | null = null;
    const sources: Source[] = [];
    const webSearch = Boolean(input.webSearch) && m.capabilities.includes("web_search");
    try {
      // SE-13: a provider this project blocks never gets the request; you see why.
      const refused = egressRefusal(policy, m.provider, "chat");
      if (refused) throw new ProviderError("blocked", refused, { code: "egress" });
      const adapter = deps.adapterFor(m.provider);
      const mine = input.defaults?.(m) ?? {};
      // "Think harder" (max) beats everything; then your default; then the router's (RT-08).
      const routed = input.route?.effort ?? null;
      const effort = routed === "max" ? routed : (mine.effort ?? routed);
      const prefixed = mine.prefix
        ? system
          ? `${mine.prefix}\n\n${system}`
          : mine.prefix
        : system;
      const options = {
        // SE-13: the Rust transport checks this chat's project policy again.
        scope: { kind: "thread" as const, id: input.threadId },
        ...(prefixed ? { system: prefixed } : {}),
        ...(webSearch ? { webSearch } : {}),
        // High effort thinks at length, and thinking counts against the output limit: give it
        // the model's whole output budget (docs/providers.md, M2), unless you set a limit.
        ...(effort ? { effort } : {}),
        ...(mine.maxOutputTokens
          ? { maxOutputTokens: Math.min(mine.maxOutputTokens, m.maxOutput) }
          : effort && effort !== "low"
            ? { maxOutputTokens: m.maxOutput }
            : {}),
      };
      for await (const ev of adapter.streamChat(history, m.id, options, input.signal)) {
        if (ev.type === "status") {
          input.onStatus?.(ev.status);
        } else if (ev.type === "citation") {
          if (!sources.some((x) => x.url === ev.url)) {
            sources.push({ url: ev.url, title: ev.title });
            input.onCitations?.([...sources]);
          }
        } else if (ev.type === "text") {
          firstTokenAt ??= now();
          answer += ev.text;
          input.onText?.(answer);
          if (now() - lastSave >= saveEvery) {
            lastSave = now();
            await updateMessageContent(db, tenant, assistantMessageId, answer);
          }
        } else if (ev.type === "done") {
          done = ev;
        } // tool calls only come when tools are offered, which chat doesn't do
      }
    } catch (e) {
      failure =
        e instanceof ProviderError
          ? e
          : input.signal?.aborted
            ? new ProviderError("aborted", "Aborted")
            : new ProviderError("stream", e instanceof Error ? e.message : String(e));
    }
    return {
      started,
      firstTokenAt,
      answer,
      done: done,
      failure: failure,
      sources,
    };
  };

  let run = await attempt(model);
  // MM-06: a provider that's down, overloaded or rate-limited (after its retries) hands the
  // answer to the same tier on the other provider, as long as nothing was shown yet.
  let failedOver: { from: CatalogModel; failure: ProviderError } | null = null;
  const fallback = input.fallback;
  if (
    !run.done &&
    run.failure?.retryable &&
    run.answer === "" &&
    fallback &&
    fallback.provider !== model.provider &&
    !input.signal?.aborted
  ) {
    await logRequest(db, tenant, {
      threadId: input.threadId,
      messageId: assistantMessageId,
      purpose: "chat",
      provider: model.provider,
      model: model.id,
      attempt: 1,
      usage: { ...EMPTY_USAGE, latencyMs: now() - run.started },
      httpStatus: run.failure.status,
      errorCode: run.failure.code ?? run.failure.kind,
      errorMessage: run.failure.message.slice(0, 500),
      providerRequestId: run.failure.providerRequestId,
      tier: input.route?.tier ?? null,
      routeRuleId: input.route?.ruleId ?? null,
    });
    failedOver = { from: model, failure: run.failure };
    model = fallback;
    await setMessageModel(db, tenant, assistantMessageId, model.provider, model.id);
    input.onStatus?.(null);
    run = await attempt(model);
  }
  const { started, firstTokenAt, answer, done, failure, sources } = run;

  const latencyMs = now() - started;
  const ttftMs = firstTokenAt === null ? null : firstTokenAt - started;
  let usage: Usage = { ...EMPTY_USAGE, latencyMs, ttftMs };
  let bestCostMicroUsd: number | null = null;
  if (done) {
    const tokens = done.usage;
    const totalInput = tokens.inputTokens + tokens.cachedInputTokens + tokens.cacheWriteTokens;
    // Searches are billed per call on top of tokens (data/models.json tool_prices).
    const searchFee = (m: CatalogModel) =>
      Math.round(
        tokens.webSearchCalls *
          (toolPrice(deps.catalog, m.provider, "web_search")?.usdPerCall ?? 0) *
          1_000_000,
      );
    const priced = (m: CatalogModel) =>
      cost({ ...usage, ...tokens }, priceFor(m, totalInput)) + searchFee(m);
    // RT-09: the same tokens on the cheapest Best model. An estimate: another model would
    // have used a different number of tokens.
    const best = input.route?.best;
    if (done.usageReported && best) bestCostMicroUsd = priced(best);
    usage = {
      ...tokens,
      costMicroUsd: done.usageReported ? priced(model) : 0,
      // null price version = cost unknown (the provider sent no usage)
      priceVersion: done.usageReported ? deps.catalog.priceVersion : null,
      latencyMs,
      ttftMs,
    };
  }

  const status = done ? "complete" : failure?.kind === "aborted" ? "stopped" : "error";
  const providerName = PROVIDER_NAMES[model.provider];
  const truncated = done !== null && LENGTH_LIMIT_STOPS.has(done.stopReason ?? "");
  const paused = done?.stopReason === "pause_turn";
  const limitNotice = truncated
    ? answer.trim() === ""
      ? "The model used its whole output limit thinking and gave no answer. Try again."
      : "The answer was cut off at the output limit."
    : paused
      ? "The search paused before the answer finished. Ask it to continue."
      : null;
  const failoverNotice = failedOver
    ? `${userMessage(failedOver.failure, PROVIDER_NAMES[failedOver.from.provider]).replace(/ Try again in a moment\.$/, "")} ${model.displayName} answered instead.`
    : null;
  const message =
    failure && status === "error"
      ? userMessage(failure, providerName)
      : [failoverNotice, limitNotice].filter(Boolean).join(" ") || null;

  const requestId = await logRequest(db, tenant, {
    threadId: input.threadId,
    messageId: assistantMessageId,
    purpose: "chat",
    provider: model.provider,
    model: model.id,
    attempt: done?.attempts ?? 1,
    usage,
    httpStatus: failure?.status ?? (done ? 200 : null),
    errorCode: failure ? (failure.code ?? failure.kind) : null,
    errorMessage: failure && status === "error" ? failure.message.slice(0, 500) : null,
    providerRequestId: done?.providerRequestId ?? failure?.providerRequestId ?? null,
    tier: input.route?.tier ?? null,
    routeRuleId: input.route?.ruleId ?? null,
  });
  await finishMessage(db, tenant, assistantMessageId, {
    bestCostMicroUsd,
    content: answer,
    status,
    usage,
    errorCode: failure ? failure.kind : truncated ? "length_limit" : paused ? "pause_turn" : null,
    errorMessage: message,
    requestId,
  });
  if (sources.length > 0) await addCitations(db, tenant, assistantMessageId, sources);
  if (fileSources.length > 0) {
    await addFileCitations(db, tenant, assistantMessageId, fileSources);
  }
  // AR-01: finished artifacts in the answer are saved (a new version when the id repeats).
  const blocks = artifactsIn(answer);
  if (blocks.length > 0)
    await saveArtifacts(db, tenant, input.threadId, assistantMessageId, blocks);

  return {
    userMessageId,
    assistantMessageId,
    status,
    costMicroUsd: usage.costMicroUsd,
    ...(message ? (status === "error" ? { error: message } : { notice: message }) : {}),
    ...(failedOver ? { failedOverFrom: failedOver.from.provider } : {}),
  };
}
