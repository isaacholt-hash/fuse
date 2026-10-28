import {
  priceFor,
  toolPrice,
  type Catalog,
  type CatalogModel,
  type EmbeddingModel,
  type ProviderId,
} from "@/catalog/catalog";
import { cost } from "@/cost/cost";
import { effectiveInstructions, systemPrompt } from "./instructions";
import { ProviderError, userMessage } from "@/providers/errors";
import { toBase64, type FilesApi } from "@/files/api";
import type { Attachment, ChatMessage, ProviderAdapter, StreamDone } from "@/providers/types";
import type { Tenant } from "@/storage/defaults";
import {
  addMessage,
  deleteMessage,
  finishMessage,
  listPath,
  setMessageModel,
  updateMessageContent,
  type Message,
} from "@/storage/messages";
import { addCitations, addFileCitations } from "@/storage/citations";
import { retrieveExcerpts } from "@/knowledge/retrieve";
import { ARTIFACT_GUIDE, artifactsIn } from "@/artifacts/parse";
import { listArtifacts, saveArtifacts } from "@/storage/artifacts";
import { listProjectFiles } from "@/storage/projectFiles";
import { isRecallQuestion, memorySimilarity, recallPastChats } from "@/knowledge/recall";
import { summarizedPath } from "./summary";
import { getGlobalInstructions } from "@/storage/instructions";
import { listMemories, recordInjected } from "@/storage/memories";
import { getMemorySettings } from "@/storage/settings";
import { memoryTokens, selectMemories } from "@/memory/inject";
import { getProject } from "@/storage/projects";
import { filesForMessages, linkFiles, type FileMode } from "@/storage/files";
import { logRequest } from "@/storage/requestLog";
import type { SqlDb } from "@/storage/sql";
import { getThread, renameThread, setActiveLeaf } from "@/storage/threads";
import { EMPTY_USAGE, type Usage } from "@/storage/usage";
import type { RouteInfo } from "@/routing/route";

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

/**
 * The history sent to the model: every saved turn with text, oldest first. The same plain-text
 * history goes to any provider, which is what makes switching model mid-thread work (CH-03).
 * Failed answers with no text are left out; partial answers (stopped, cut off) are kept.
 * An answer re-run on a stronger model (RT-04) is left out in favour of the newer one.
 */
export function historyFor(
  messages: Message[],
  attachments: ReadonlyMap<string, Attachment[]> = new Map(),
): ChatMessage[] {
  const superseded = new Set(messages.map((m) => m.escalatedFromId).filter(Boolean));
  return messages
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        !superseded.has(m.id) &&
        (m.content.trim() !== "" || attachments.has(m.id)),
    )
    .map((m) => {
      const files = attachments.get(m.id);
      return {
        role: m.role as "user" | "assistant",
        content: m.content,
        ...(files ? { attachments: files } : {}),
      };
    });
}

/** Loads the bytes of every file attached to these messages (resent each turn). */
async function attachmentsFor(
  deps: ChatDeps,
  messages: Message[],
): Promise<Map<string, Attachment[]>> {
  const byMessage = await filesForMessages(
    deps.db,
    deps.tenant,
    messages.filter((m) => m.role === "user").map((m) => m.id),
  );
  const out = new Map<string, Attachment[]>();
  for (const [messageId, files] of byMessage) {
    if (!deps.files) throw new Error("This message has attachments but no file store is set up");
    const loaded: Attachment[] = [];
    for (const f of files) {
      if (f.mode === "retrieval") {
        // Searched per question (FK-03): only a note goes in the history; excerpts come with
        // the question being answered (contextOf).
        loaded.push({
          kind: "text",
          name: f.name,
          text: "(A large file. It isn't sent whole: the parts that match each question are.)",
        });
        continue;
      }
      const bytes = await deps.files.get(f.sha256);
      if (f.mime.startsWith("image/")) {
        loaded.push({ kind: "image", mediaType: f.mime, data: toBase64(bytes) });
      } else if (f.mime === "application/pdf") {
        loaded.push({ kind: "pdf", name: f.name, data: toBase64(bytes) });
      } else {
        loaded.push({ kind: "text", name: f.name, text: new TextDecoder().decode(bytes) });
      }
    }
    out.set(messageId, loaded);
  }
  return out;
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

/** What a model is sent before the new answer: the history and any summary of older turns. */
interface Context {
  history: ChatMessage[];
  earlier: string | null;
  /** File excerpts sent with the question, for the answer's citations (FK-02). */
  fileSources: { chunkId: string; label: string }[];
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
  return contextOf(deps, threadId, path.slice(0, end), embedding);
}

/**
 * Older turns go as a summary once the thread has one (PM-06); the rest is sent in full. Large
 * files are searched: the question gets the excerpts that match it (FK-02).
 */
async function contextOf(
  deps: ChatDeps,
  threadId: string,
  path: Message[],
  embedding: EmbeddingModel | null | undefined,
): Promise<Context> {
  const { earlier, kept } = await summarizedPath(deps, threadId, path);
  const history = historyFor(kept, await attachmentsFor(deps, kept));
  const files = await filesForMessages(
    deps.db,
    deps.tenant,
    kept.filter((m) => m.role === "user").map((m) => m.id),
  );
  // PM-09: a project's knowledge files are searched for every chat in it.
  const thread = await getThread(deps.db, deps.tenant, threadId);
  const knowledge = thread?.projectId
    ? await listProjectFiles(deps.db, deps.tenant, thread.projectId)
    : [];
  const searched = [
    ...new Map(
      [...[...files.values()].flat().filter((f) => f.mode === "retrieval"), ...knowledge].map(
        (f) => [f.id, f],
      ),
    ).values(),
  ];
  const last = history.at(-1);
  const question = kept.findLast((m) => m.role === "user")?.content ?? "";
  // PM-10: "what did we decide about X" gets the matching parts of past chats.
  const recalled =
    last?.role === "user" && isRecallQuestion(question)
      ? await recallPastChats(deps, question, threadId)
      : null;
  if (recalled && last) {
    last.attachments = [
      ...(last.attachments ?? []),
      { kind: "text", name: "From your earlier chats", text: recalled.text },
    ];
  }
  const recallSources = recalled?.sources ?? [];
  if (searched.length === 0 || last?.role !== "user") {
    return { history, earlier, fileSources: recallSources };
  }
  // Without an OpenAI key a project's files simply aren't used; a file attached to search fails.
  if (!embedding && knowledge.length === searched.length) {
    return { history, earlier, fileSources: recallSources };
  }
  if (!embedding) {
    throw new Error(
      "Searching inside large files needs an OpenAI key (Anthropic has no embeddings). Add one in Settings, or attach the file again and send it whole.",
    );
  }
  if (!deps.files) throw new Error("This message has attachments but no file store is set up");
  const excerpts = await retrieveExcerpts(
    { ...deps, files: deps.files, priceVersion: deps.catalog.priceVersion },
    embedding,
    searched,
    question,
    threadId,
  );
  last.attachments = [
    ...(last.attachments ?? []),
    { kind: "text", name: "Excerpts from your files", text: excerpts.text },
  ];
  return { history, earlier, fileSources: [...excerpts.sources, ...recallSources] };
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
    context: await contextOf(deps, threadId, messages.slice(0, lastUserIndex + 1), embedding),
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
  { history, earlier, fileSources }: Context,
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

  /** AR-02: artifacts you edited or restored, so the model works from what you have now. */
  const editedArtifacts = async () => {
    const changed = (await listArtifacts(db, tenant, input.threadId)).filter(
      (a) => a.source !== "model",
    );
    return changed.length === 0
      ? []
      : [
          [
            "<edited_artifacts>",
            "The user changed these artifacts after you last wrote them. This is their current content; build on it (same id) rather than on your earlier version.",
            ...changed.map(
              (a) =>
                `<artifact id="${a.key}" type="${a.type}" title="${a.title.replace(/"/g, "'")}"${a.language ? ` language="${a.language}"` : ""}>\n${a.content}\n</artifact>`,
            ),
            "</edited_artifacts>",
          ].join("\n"),
        ];
  };
  /**
   * PM-04: the memories for this question. When they don't all fit the budget they're ranked by
   * shared words and, with an embedding model, by meaning.
   */
  const pickMemories = async () => {
    const all = await listMemories(db, tenant);
    const budget = (await getMemorySettings(db, tenant)).budgetTokens;
    const question = history.findLast((m) => m.role === "user")?.content ?? "";
    const query = `${thread?.title ?? ""}\n${question}`;
    const projectId = thread?.projectId ?? null;
    const pool = all.filter((m) => m.projectId === null || m.projectId === projectId);
    const overBudget = pool.reduce((sum, m) => sum + memoryTokens(m), 0) > budget;
    const similarity =
      overBudget && input.embedding && budget > 0
        ? await memorySimilarity(
            { ...deps, priceVersion: deps.catalog.priceVersion },
            input.embedding,
            pool,
            question,
            input.threadId,
          ).catch(() => new Map<string, number>()) // keywords alone still work
        : new Map<string, number>();
    return selectMemories(all, query, projectId, budget, similarity);
  };
  // Read at send time, so an edit applies from the next message on (and on retry).
  const thread = await getThread(db, tenant, input.threadId);
  const project = thread?.projectId ? await getProject(db, tenant, thread.projectId) : null;
  // Memories matched to the question being answered (PM-04), unless this chat turned them off.
  const injected = thread && !thread.memoryOn ? [] : await pickMemories();
  await recordInjected(
    db,
    tenant,
    assistantMessageId,
    injected.map((m) => m.id),
  );
  const system = systemPrompt(
    effectiveInstructions(
      await getGlobalInstructions(db, tenant),
      project?.instructions ?? "",
      thread?.instructions ?? "",
    ),
    injected.map((m) => m.text),
    earlier,
    [ARTIFACT_GUIDE],
    await editedArtifacts(),
  );

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
      const adapter = deps.adapterFor(m.provider);
      const effort = input.route?.effort ?? null;
      const options = {
        ...(system ? { system } : {}),
        ...(webSearch ? { webSearch } : {}),
        // High effort thinks at length, and thinking counts against the output limit: give it
        // the model's whole output budget (docs/providers.md, M2).
        ...(effort ? { effort } : {}),
        ...(effort && effort !== "low" ? { maxOutputTokens: m.maxOutput } : {}),
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
        } else {
          done = ev;
        }
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
