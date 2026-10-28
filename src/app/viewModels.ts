// Pure mapping from storage records and the catalog to the UI's view models.
import { findModel, priceFor, toolPrice, type Catalog, type CatalogModel } from "@/catalog/catalog";
import { PROVIDER_NAMES } from "@/chat/sendMessage";
import { cost } from "@/cost/cost";
import { splitAnswer } from "@/artifacts/parse";
import { INTENT_LABELS } from "@/routing/classify";
import type { FileRecord } from "@/storage/files";
import type { Message } from "@/storage/messages";
import type { RequestLogRecord } from "@/storage/requestLog";
import type { Thread } from "@/storage/threads";
import { EMPTY_USAGE } from "@/storage/usage";
import type {
  ImageView,
  MessageView,
  ModelOption,
  RequestRow,
  RouteView,
  SourceView,
  ThreadGroup,
  ThreadView,
  UsageView,
} from "@/ui/types";

const DAY_MS = 86_400_000;

const contextLabel = (tokens: number) =>
  tokens >= 1_000_000
    ? `${String(+(tokens / 1_000_000).toFixed(1))}M`
    : `${String(Math.round(tokens / 1000))}K`;

export function modelOption(m: CatalogModel): ModelOption {
  return {
    id: m.id,
    provider: m.provider,
    providerName: PROVIDER_NAMES[m.provider],
    name: m.displayName,
    context: contextLabel(m.contextWindow),
    inputPrice: m.price.input,
    outputPrice: m.price.output,
  };
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Sidebar group by local calendar day. */
export function groupFor(ms: number, now: number): ThreadGroup {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  return "Older";
}

export function threadView(t: Thread, now: number): ThreadView {
  return {
    id: t.id,
    title: t.title,
    group: groupFor(t.lastMessageAt ?? t.createdAt, now),
    costMicro: t.costMicroUsd,
    projectId: t.projectId,
  };
}

function usageView(m: Message, catalog: Catalog, model: CatalogModel | undefined): UsageView {
  const u = m.usage;
  const totalInput = u.inputTokens + u.cachedInputTokens + u.cacheWriteTokens;
  // Per-part costs only when the answer was priced with the catalog we have now.
  const price =
    model && u.priceVersion === catalog.priceVersion ? priceFor(model, totalInput) : null;
  const part = (
    field: "inputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "outputTokens",
  ) => (price ? cost({ ...EMPTY_USAGE, [field]: u[field] }, price) : 0);
  return {
    freshInput: u.inputTokens,
    cachedInput: u.cachedInputTokens,
    cacheWrite: u.cacheWriteTokens,
    output: u.outputTokens,
    reasoning: u.reasoningTokens,
    webSearchCalls: u.webSearchCalls,
    parts: price
      ? {
          fresh: part("inputTokens"),
          cached: part("cachedInputTokens"),
          cacheWrite: part("cacheWriteTokens"),
          output: part("outputTokens"),
          webSearch: Math.round(
            u.webSearchCalls *
              (model ? (toolPrice(catalog, model.provider, "web_search")?.usdPerCall ?? 0) : 0) *
              1_000_000,
          ),
        }
      : null,
    totalMicro: u.priceVersion === null ? null : u.costMicroUsd,
    latencyMs: u.latencyMs,
  };
}

const TIER_LABELS: Record<string, string> = { cheap: "Cheap", balanced: "Balanced", best: "Best" };

/** The routing badge: how the model was picked, and the same tokens priced on Best (RT-09). */
export function routeView(m: Message): RouteView | undefined {
  const r = m.route;
  if (!r) return undefined;
  const tier = r.tier ? (TIER_LABELS[r.tier] ?? r.tier) : null;
  const label = m.escalatedFromId
    ? `Stronger · ${tier ?? "?"}`
    : r.mode === "model"
      ? "Your pick"
      : `${r.mode === "auto" ? "Auto" : "Pinned"} · ${tier ?? "?"}`;
  const labels: Partial<Record<string, string>> = INTENT_LABELS;
  const intent = r.intent ? (labels[r.intent] ?? r.intent) : null;
  return {
    label,
    reason: r.reason,
    readAs: intent && r.complexity ? `${intent}, ${r.complexity}` : null,
    bestMicro: r.tier === "best" ? null : m.bestCostMicroUsd,
  };
}

/** Messages for display, with model-switch dividers between answers from different models. */
export function messageViews(
  messages: Message[],
  catalog: Catalog,
  images: ReadonlyMap<string, ImageView[]> = new Map(),
  sources: ReadonlyMap<string, SourceView[]> = new Map(),
  memories: ReadonlyMap<string, { text: string }[]> = new Map(),
): MessageView[] {
  const out: MessageView[] = [];
  let lastModel: string | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      const attached = images.get(m.id);
      out.push({
        id: m.id,
        role: "user",
        content: m.content,
        status: "complete",
        ...(attached ? { images: attached } : {}),
      });
      continue;
    }
    if (m.role !== "assistant") continue;
    const provider = m.provider === "openai" || m.provider === "anthropic" ? m.provider : null;
    const model = provider && m.model ? findModel(catalog, provider, m.model) : undefined;
    const name = model?.displayName ?? m.model ?? "Unknown model";
    const key = `${m.provider ?? ""}/${m.model ?? ""}`;
    const view: MessageView = {
      id: m.id,
      role: "assistant",
      content: m.content,
      status: m.status,
      providerName: provider ? PROVIDER_NAMES[provider] : (m.provider ?? ""),
      model: name,
      feedback: m.feedback,
    };
    const parts = splitAnswer(m.content);
    if (parts.some((p) => p.kind === "artifact")) {
      view.parts = parts.map((p) =>
        p.kind === "text"
          ? p
          : {
              kind: "artifact",
              key: p.artifact.key,
              title: p.artifact.title,
              type: p.artifact.type,
              language: p.artifact.language,
              complete: p.artifact.complete,
            },
      );
    }
    if (m.escalatedFromId) {
      view.switchLabel = `Stronger model: ${name} · same question`;
    } else if (lastModel !== null && key !== lastModel) {
      view.switchLabel = `Switched to ${name} · full history sent`;
    }
    lastModel = key;
    // Badge on finished answers that were priced, or complete ones whose cost is unknown.
    if (m.status !== "streaming" && (m.usage.priceVersion !== null || m.status === "complete")) {
      view.usage = usageView(m, catalog, model);
    }
    const routed = m.status === "streaming" ? undefined : routeView(m);
    if (routed) view.route = routed;
    const cited = sources.get(m.id);
    if (cited?.length) view.sources = cited;
    const used = memories.get(m.id);
    if (used?.length) view.memories = used.map((x) => x.text);
    if (m.status === "error") view.error = m.errorMessage ?? "Something went wrong.";
    if (m.status === "complete" && m.errorMessage) view.notice = m.errorMessage;
    out.push(view);
  }
  return out;
}

/** Share of a thread's input tokens read from the provider's cache (RT-07); null with no input. */
export function cacheHitRate(messages: Message[]): number | null {
  let cached = 0;
  let input = 0;
  for (const m of messages) {
    cached += m.usage.cachedInputTokens;
    input += m.usage.inputTokens + m.usage.cachedInputTokens + m.usage.cacheWriteTokens;
  }
  return input > 0 ? cached / input : null;
}

/** All tokens billed in a thread (input incl. cache, plus output). */
export function threadTokens(messages: Message[]): number {
  return messages.reduce(
    (sum, m) =>
      sum +
      m.usage.inputTokens +
      m.usage.cachedInputTokens +
      m.usage.cacheWriteTokens +
      m.usage.outputTokens,
    0,
  );
}

/** An answer streaming right now. The text arrives faster than it's saved, so it's kept in memory. */
export interface LiveAnswer {
  threadId: string;
  model: CatalogModel;
  text: string;
  /** The question being sent; null when retrying the last one. */
  userText: string | null;
  /** Files sent with the question (shown on the synthetic row until the saved one loads). */
  files: FileRecord[];
  /** The provider is running a web search right now. */
  searching?: boolean;
  /** Sources cited so far. */
  sources?: SourceView[];
  /**
   * Where the answer goes until its saved row loads: after this message id (rows after it are
   * replaced), at the start (null), or at the end (undefined, a new question).
   */
  after?: string | null;
}

/**
 * Stored messages with the live answer laid over them. Once the engine has saved its placeholder
 * row, the live text replaces that row's (older) saved text; before that, synthetic rows stand in.
 */
export function withLive(base: Message[], live: LiveAnswer | undefined): Message[] {
  if (!live) return base;
  const saved = base.findLastIndex((m) => m.role === "assistant" && m.status === "streaming");
  if (saved >= 0) return base.map((m, i) => (i === saved ? { ...m, content: live.text } : m));
  // Retry, regenerate and edit replace what came after `after`; a stronger re-run goes under it.
  const cut =
    live.after === undefined
      ? base.length
      : live.after === null
        ? 0
        : base.findIndex((m) => m.id === live.after) + 1;
  const rows = base.slice(0, cut > 0 || live.after === null ? cut : base.length);
  const row = (id: string, fields: Partial<Message>): Message => ({
    id,
    threadId: live.threadId,
    parentId: null,
    role: "user",
    content: "",
    status: "complete",
    errorCode: null,
    errorMessage: null,
    provider: null,
    model: null,
    usage: EMPTY_USAGE,
    requestId: null,
    route: null,
    bestCostMicroUsd: null,
    escalatedFromId: null,
    feedback: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...fields,
  });
  return [
    ...rows,
    ...(live.userText === null ? [] : [row("live-question", { content: live.userText })]),
    row("live-answer", {
      role: "assistant",
      content: live.text,
      status: "streaming",
      provider: live.model.provider,
      model: live.model.id,
    }),
  ];
}

const PURPOSE_LABELS: Partial<Record<RequestLogRecord["purpose"], string>> = {
  key_test: "Key test",
};
/** Housekeeping calls show the model and what the call was for. */
const CHORE_LABELS: Partial<Record<RequestLogRecord["purpose"], string>> = {
  title: "chat title",
  memory: "memory",
};

/** One request_log row for the debug panel. */
export function requestRow(r: RequestLogRecord, catalog: Catalog, now: number): RequestRow {
  const provider = r.provider === "openai" || r.provider === "anthropic" ? r.provider : null;
  const model = provider ? findModel(catalog, provider, r.model) : undefined;
  const u = r.usage;
  const d = new Date(r.createdAt);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const stopped = r.errorCode === "aborted";
  const failed = !stopped && r.errorCode !== null;
  return {
    id: r.id,
    time:
      groupFor(r.createdAt, now) === "Today"
        ? time
        : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`,
    provider: provider ? PROVIDER_NAMES[provider] : r.provider,
    model:
      PURPOSE_LABELS[r.purpose] ??
      [model?.displayName ?? r.model, CHORE_LABELS[r.purpose]].filter(Boolean).join(" · "),
    input: u.inputTokens + u.cachedInputTokens + u.cacheWriteTokens,
    output: u.outputTokens,
    cached: u.cachedInputTokens,
    reasoning: u.reasoningTokens,
    cost: u.priceVersion === null ? (r.purpose === "key_test" ? 0 : null) : u.costMicroUsd,
    latency: u.latencyMs === null ? "—" : `${(u.latencyMs / 1000).toFixed(1)} s`,
    tone: stopped ? "stopped" : failed ? "error" : "ok",
    status: stopped
      ? "Stopped"
      : failed
        ? `${r.httpStatus === null ? "" : `${String(r.httpStatus)} · `}${r.errorMessage ?? r.errorCode ?? "Error"}`
        : `OK${r.attempt > 1 ? ` after ${String(r.attempt)} tries` : ""}`,
    requestId: r.providerRequestId,
  };
}
