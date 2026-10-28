import {
  priceFor,
  toolPrice,
  type Catalog,
  type CatalogModel,
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
  listMessages,
  updateMessageContent,
  type Message,
} from "@/storage/messages";
import { addCitations } from "@/storage/citations";
import { getGlobalInstructions } from "@/storage/instructions";
import { listMemories, recordInjected } from "@/storage/memories";
import { getMemorySettings } from "@/storage/settings";
import { selectMemories } from "@/memory/inject";
import { getProject } from "@/storage/projects";
import { filesForMessages, linkFiles } from "@/storage/files";
import { logRequest } from "@/storage/requestLog";
import type { SqlDb } from "@/storage/sql";
import { getThread, renameThread } from "@/storage/threads";
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
}

/**
 * The history sent to the model: every saved turn with text, oldest first. The same plain-text
 * history goes to any provider, which is what makes switching model mid-thread work (CH-03).
 * Failed answers with no text are left out; partial answers (stopped, cut off) are kept.
 */
export function historyFor(
  messages: Message[],
  attachments: ReadonlyMap<string, Attachment[]> = new Map(),
): ChatMessage[] {
  return messages
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
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

  const previous = await listMessages(db, tenant, input.threadId);
  const userMessageId = await addMessage(db, tenant, {
    threadId: input.threadId,
    parentId: previous.at(-1)?.id ?? null,
    role: "user",
    content: text,
  });
  await linkFiles(db, tenant, userMessageId, fileIds);
  if (previous.length === 0) {
    const thread = await getThread(db, tenant, input.threadId);
    if (thread?.titleSource === "auto") {
      await renameThread(db, tenant, input.threadId, titleFrom(text, fileIds.length > 0), "auto");
    }
  }
  const messages = await listMessages(db, tenant, input.threadId);
  const history = historyFor(messages, await attachmentsFor(deps, messages));
  return streamAnswer(deps, input, userMessageId, history);
}

export type RetryInput = Omit<SendInput, "text" | "fileIds">;

/**
 * Re-asks the last question (after an error or a stop), optionally on another model.
 * The failed or stopped answer is removed so the thread reads cleanly.
 */
export async function retryLast(deps: ChatDeps, input: RetryInput): Promise<SendResult> {
  const { db, tenant } = deps;
  const messages = await listMessages(db, tenant, input.threadId);
  const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
  const lastUser = messages[lastUserIndex];
  if (!lastUser) throw new Error("Nothing to retry");
  for (const m of messages.slice(lastUserIndex + 1)) await deleteMessage(db, tenant, m.id);
  const kept = messages.slice(0, lastUserIndex + 1);
  const history = historyFor(kept, await attachmentsFor(deps, kept));
  return streamAnswer(deps, input, lastUser.id, history);
}

async function streamAnswer(
  deps: ChatDeps,
  input: RetryInput,
  userMessageId: string,
  history: ChatMessage[],
): Promise<SendResult> {
  const { db, tenant } = deps;
  const { model } = input;
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
  });

  const started = now();
  let firstTokenAt: number | null = null;
  let answer = "";
  let lastSave = started;
  let done: StreamDone | null = null;
  let failure: ProviderError | null = null;
  const sources: Source[] = [];
  const webSearch = Boolean(input.webSearch) && model.capabilities.includes("web_search");
  // Read at send time, so an edit applies from the next message on (and on retry).
  const thread = await getThread(db, tenant, input.threadId);
  const project = thread?.projectId ? await getProject(db, tenant, thread.projectId) : null;
  // Memories matched to the question being answered (PM-04), unless this chat turned them off.
  const injected =
    thread && !thread.memoryOn
      ? []
      : selectMemories(
          await listMemories(db, tenant),
          `${thread?.title ?? ""}\n${history.findLast((m) => m.role === "user")?.content ?? ""}`,
          thread?.projectId ?? null,
          (await getMemorySettings(db, tenant)).budgetTokens,
        );
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
  );

  try {
    const adapter = deps.adapterFor(model.provider);
    const options = {
      ...(system ? { system } : {}),
      ...(webSearch ? { webSearch } : {}),
    };
    for await (const ev of adapter.streamChat(history, model.id, options, input.signal)) {
      if (ev.type === "status") {
        input.onStatus?.(ev.status);
      } else if (ev.type === "citation") {
        if (!sources.some((s) => s.url === ev.url)) {
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
  const message =
    failure && status === "error"
      ? userMessage(failure, providerName)
      : truncated
        ? answer.trim() === ""
          ? "The model used its whole output limit thinking and gave no answer. Try again."
          : "The answer was cut off at the output limit."
        : paused
          ? "The search paused before the answer finished. Ask it to continue."
          : null;

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

  return {
    userMessageId,
    assistantMessageId,
    status,
    costMicroUsd: usage.costMicroUsd,
    ...(message ? (status === "error" ? { error: message } : { notice: message }) : {}),
  };
}
