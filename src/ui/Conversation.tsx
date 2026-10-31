import { money, number } from "./format";
import {
  ArrowDown,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Command,
  Copy,
  Quote,
  ThumbsDown,
  ThumbsUp,
  CornerDownLeft,
  LoaderCircle,
  FileText,
  Pencil,
  RotateCcw,
  Globe,
  Paperclip,
  Search,
  Square,
  Sparkles,
  X,
  Briefcase,
  FolderOpen,
  FolderPlus,
  Columns2,
  Ellipsis,
  FolderTree,
  SquareTerminal,
} from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { fuzzyScore } from "./fuzzy";
import { DOCUMENT_ACCEPT } from "@/files/documents";
import { Markdown } from "./Markdown";
import { ArtifactCard, DiffView } from "./Artifacts";
import { openExternal } from "./openExternal";
import { Hint, Mark, Tip } from "./primitives";
import type {
  MessageView,
  RunView,
  ModeChoice,
  ModelOption,
  PendingAttachment,
  RouteView,
  RoutingView,
  UsageView,
} from "./types";

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const MODE_LABELS: Record<ModeChoice, string> = {
  auto: "Auto",
  balanced: "Balanced",
  best: "Best",
};

/** How the answer's model was picked, and what Best would have cost (RT-09). */
function RouteBadge({ route }: { route: RouteView }) {
  return (
    <Tip
      label={
        <div className="w-64 space-y-1.5 py-1 text-[11px] leading-4">
          <p className="font-medium">Why this model</p>
          <p>{route.reason}</p>
          {route.readAs && <p className="text-muted-foreground">Read as: {route.readAs}</p>}
          {route.bestMicro !== null && (
            <p className="text-muted-foreground">
              On Best: about {money(route.bestMicro)} (the same tokens on the cheapest Best model)
            </p>
          )}
        </div>
      }
    >
      <button
        className="mt-4 flex items-center gap-1.5 rounded py-1 font-mono text-[10px] leading-5 text-muted-foreground hover:text-foreground"
        aria-label={`Routing: ${route.label}`}
      >
        <span className="text-foreground/70">{route.label}</span>
        {route.bestMicro !== null && <span>· {money(route.bestMicro)} on Best</span>}
      </button>
    </Tip>
  );
}

/** 45K, 1M: token counts for the context meter. */
const compact = (n: number) =>
  n >= 1_000_000
    ? `${String(+(n / 1_000_000).toFixed(1))}M`
    : n >= 1000
      ? `${String(Math.round(n / 1000))}K`
      : String(n);

const tokensIn = (u: UsageView) => u.freshInput + u.cachedInput + u.cacheWrite;

function CostBadge({ message }: { message: MessageView }) {
  if (message.cachedFrom) {
    return (
      <Tip
        label={`${message.cachedFrom} answered the same first question, in the same context, earlier; FUSE reused that answer at no cost. Regenerate asks the model again.`}
      >
        <button
          className="mt-4 flex items-center gap-1.5 rounded py-1 font-mono text-[10px] leading-5 text-muted-foreground hover:text-foreground"
          aria-label="Answered from the cache"
        >
          <span>from cache · {message.cachedFrom}</span>
          <span>·</span>
          <span className="text-foreground/70">$0</span>
        </button>
      </Tip>
    );
  }
  if (message.noModel) {
    return (
      <Tip label={`${message.noModel}: worked out by a fixed rule in FUSE, so no model was asked.`}>
        <button
          className="mt-4 flex items-center gap-1.5 rounded py-1 font-mono text-[10px] leading-5 text-muted-foreground hover:text-foreground"
          aria-label="Answered without a model"
        >
          <span>answered without a model</span>
          <span>·</span>
          <span className="text-foreground/70">$0</span>
        </button>
      </Tip>
    );
  }
  const usage = message.usage;
  if (!usage) return null;
  const parts = usage.parts;
  const rows: [string, number, number | null | undefined][] = [
    ["Input", usage.freshInput, parts?.fresh],
    ["Cached input", usage.cachedInput, parts?.cached],
    ["Cache write", usage.cacheWrite, parts?.cacheWrite],
    ["Output (incl. reasoning)", usage.output, parts?.output],
    ["Web searches", usage.webSearchCalls, parts?.webSearch],
  ];
  return (
    <Tip
      label={
        <div className="w-64 space-y-2 py-1 font-mono">
          <p className="mb-3 font-sans font-medium">Request breakdown</p>
          {rows
            .filter(
              ([label, tokens]) => tokens > 0 || label === "Input" || label.startsWith("Output"),
            )
            .map(([label, tokens, micro]) => (
              <div key={label} className="flex justify-between gap-3 text-[10px]">
                <span className="font-sans">{label}</span>
                <span className="ml-auto">{number(tokens)}</span>
                <span className="w-14 text-right">{micro == null ? "" : money(micro)}</span>
              </div>
            ))}
          {usage.reasoning > 0 && (
            <div className="flex justify-between gap-3 text-[10px] text-muted-foreground">
              <span className="font-sans">Reasoning (in output)</span>
              <span className="ml-auto">{number(usage.reasoning)}</span>
              <span className="w-14" />
            </div>
          )}
          <div className="flex justify-between border-t pt-2 text-[10px]">
            <span className="font-sans">Total</span>
            <span>{usage.totalMicro === null ? "unknown" : money(usage.totalMicro)}</span>
          </div>
          {usage.latencyMs !== null && (
            <div className="flex justify-between text-[10px]">
              <span className="font-sans">Time</span>
              <span>{(usage.latencyMs / 1000).toFixed(1)} s</span>
            </div>
          )}
        </div>
      }
    >
      <button
        className="mt-4 flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 rounded py-1 text-left font-mono text-[10px] leading-5 text-muted-foreground hover:text-foreground"
        aria-label={`Cost breakdown for ${message.model ?? "model"}`}
      >
        <span>{message.model}</span>
        <span>·</span>
        <span>
          {number(tokensIn(usage))} in / {number(usage.output)} out
        </span>
        {usage.cachedInput > 0 && <span>· {number(usage.cachedInput)} cached</span>}
        {usage.webSearchCalls > 0 && (
          <span>
            · {number(usage.webSearchCalls)} search{usage.webSearchCalls === 1 ? "" : "es"}
          </span>
        )}
        <span>·</span>
        <span className="text-foreground/70">
          {usage.totalMicro === null ? "cost unknown" : money(usage.totalMicro)}
        </span>
        <ChevronDown className="ml-0.5 size-3 opacity-60" />
      </button>
    </Tip>
  );
}

function MemoryBadge({ memories }: { memories: { text: string; why: string }[] }) {
  return (
    <Tip
      label={
        <div className="w-64 space-y-1.5 py-1">
          <p className="mb-2 font-medium">Memories sent with this answer</p>
          <ul className="space-y-1 text-[11px] leading-4">
            {memories.map((m, i) => (
              <li key={i}>
                · {m.text}
                {m.why && <span className="block pl-2 text-[10px] opacity-70">{m.why}</span>}
              </li>
            ))}
          </ul>
        </div>
      }
    >
      <button
        className="mt-4 flex items-center gap-1 rounded py-1 font-mono text-[10px] leading-5 text-muted-foreground hover:text-foreground"
        aria-label={`${String(memories.length)} ${memories.length === 1 ? "memory" : "memories"} used`}
      >
        <Brain className="size-3" />
        {memories.length}
      </button>
    </Tip>
  );
}

/**
 * CH-13: text selected inside one answer, with where to show "Reply to this" (just under the
 * selection, relative to the messages pane). Null when nothing in a single answer is selected.
 */
function selectedQuote(
  pane: HTMLElement | null,
): { text: string; top: number; left: number } | null {
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? "";
  if (!sel || !pane || !text || sel.rangeCount === 0) return null;
  const answerOf = (node: Node | null) =>
    (node instanceof Element ? node : node?.parentElement)?.closest("[data-answer]") ?? null;
  const answer = answerOf(sel.anchorNode);
  if (!answer || answer !== answerOf(sel.focusNode) || !pane.contains(answer)) return null;
  const range = sel.getRangeAt(0);
  const box = pane.parentElement?.getBoundingClientRect();
  // jsdom has no layout for ranges; the button then sits at the top left.
  const rect =
    typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
  return {
    text,
    top: rect && box ? Math.max(0, rect.bottom - box.top + 6) : 0,
    left: rect && box ? Math.max(0, rect.left - box.left) : 0,
  };
}

/** ‹ 2/3 › between an edited question's or a regenerated answer's versions (CH-04). */
function BranchPicker({
  branch,
  label,
  onStep,
}: {
  branch: { position: number; total: number };
  label: string;
  onStep?: (step: -1 | 1) => void;
}) {
  return (
    <span
      className="flex items-center font-mono text-[10px] text-muted-foreground"
      role="group"
      aria-label={`${label} versions`}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Previous ${label}`}
        disabled={!onStep || branch.position <= 1}
        onClick={() => onStep?.(-1)}
      >
        <ChevronLeft />
      </Button>
      <span>
        {branch.position}/{branch.total}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Next ${label}`}
        disabled={!onStep || branch.position >= branch.total}
        onClick={() => onStep?.(1)}
      >
        <ChevronRight />
      </Button>
    </span>
  );
}

/** Edits a question in place; sending makes a new branch. */
function EditQuestion({
  initial,
  onSend,
  onCancel,
}: {
  initial: string;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="self-stretch rounded-2xl border bg-background p-3">
      <textarea
        aria-label="Edit message"
        autoFocus
        value={text}
        rows={Math.min(10, Math.max(2, text.split("\n").length))}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && text.trim()) {
            e.preventDefault();
            onSend(text.trim());
          }
        }}
        className="block w-full resize-none bg-transparent text-[13px] leading-6 outline-none"
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!text.trim()}
          onClick={() => {
            onSend(text.trim());
          }}
        >
          Send edit
        </Button>
      </div>
    </div>
  );
}

const startedLabel = (ms: number) => {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? `Today, ${time}`
    : `${d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}, ${time}`;
};

export function Messages({
  messages,
  modelName,
  startedAt,
  onRetry,
  onEscalate,
  onFeedback,
  onQuote,
  onBranch,
  onRegenerate,
  onEdit,
  busy = false,
  focusId = null,
  openArtifact = null,
  onOpenArtifact,
  onSideBySide,
  onOpenFile,
  onOpenSource,
  onContinueRun,
  onUndoChange,
  onUndoRun,
  onApprove,
  onPreviewChange,
}: {
  /** WF-05: opens a file a run made or changed in the side panel. */
  onPreviewChange?: (changeId: string) => void;
  /** CA-03, CA-04: answers what a run asked for ("always": don't ask again for this command). */
  onApprove?: (runId: string, answer: "yes" | "always" | "no" | { keep: number[] }) => void;
  /** M6: goes on with a paused or stopped coding run; `raise` adds to its cost cap first. */
  onContinueRun?: (runId: string, raise: boolean) => void;
  /** CA-02: puts one file a run changed back as it was. */
  onUndoChange?: (changeId: string) => void;
  /** CA-02: undoes everything a run changed. */
  onUndoRun?: (runId: string) => void;
  /** FK-10: opens an attached file in the side panel. */
  onOpenFile?: (fileId: string) => void;
  /** FK-10: opens a cited file at the cited place (a chunk). */
  onOpenSource?: (chunkId: string) => void;
  /** CH-17: an answer's versions side by side. */
  onSideBySide?: (answerId: string) => void;
  messages: MessageView[];
  /** Selected model, for the empty state. */
  modelName: string;
  /** When the conversation started (Unix ms). */
  startedAt: number | null;
  onRetry: () => void;
  /** "Try a stronger model" on the latest answer (RT-04). */
  onEscalate?: () => void;
  /** Thumbs up or down on an answer; null clears it (CH-07). */
  onFeedback?: (id: string, value: "up" | "down" | null) => void;
  /** Puts an answer into the composer as a quote. */
  onQuote?: (text: string) => void;
  /** Shows the previous or next version of a message (CH-04). */
  onBranch?: (id: string, step: -1 | 1) => void;
  /** A fresh answer to the same question, on a new branch. */
  onRegenerate?: (answerId: string) => void;
  /** Sends an edited question on a new branch. */
  onEdit?: (messageId: string, text: string) => void;
  /** An answer is streaming: edits, regenerates and branch switches wait. */
  busy?: boolean;
  /** A message to scroll to and highlight (a search result). */
  focusId?: string | null;
  /** The artifact open in the side panel, by key (AR-01). */
  openArtifact?: string | null;
  onOpenArtifact?: (key: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  // CH-13: text selected in an answer, offered as a quote for the reply.
  const [picked, setPicked] = useState<{ text: string; top: number; left: number } | null>(null);
  const lastMessage = messages.at(-1);
  // Follow the answer while it streams, unless the user has scrolled up to read.
  useEffect(() => {
    if (lastMessage?.status === "streaming" && scrollRef.current && !away)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lastMessage?.content, lastMessage?.status, away]);
  // Open at the latest message, and jump there when a new one is added.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);
  // A search result opens at its message (after the jump to the latest one above).
  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(`message-${focusId}`);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- jsdom has no scrollIntoView
    el?.scrollIntoView?.({ block: "center" });
  }, [focusId, messages.length]);
  return (
    <div className="relative min-h-0 flex-1">
      {picked && onQuote && (
        <Button
          size="sm"
          variant="outline"
          className="absolute z-20 h-7 gap-1.5 bg-background text-xs shadow-md"
          style={{ top: picked.top, left: picked.left }}
          onMouseDown={(e) => {
            // Keep the selection while the click lands.
            e.preventDefault();
          }}
          onClick={() => {
            onQuote(picked.text);
            window.getSelection()?.removeAllRanges();
            setPicked(null);
          }}
        >
          <Quote className="size-3" />
          Reply to this
        </Button>
      )}
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto scroll-smooth"
        onScroll={(e) => {
          const el = e.currentTarget;
          setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 240);
          setPicked(null);
        }}
        onMouseUp={() => {
          setPicked(selectedQuote(scrollRef.current));
        }}
        onKeyUp={() => {
          setPicked(selectedQuote(scrollRef.current));
        }}
      >
        {messages.length === 0 ? (
          <div className="flex min-h-full flex-col items-center justify-center px-8 py-10 text-center">
            <div className="mb-5">
              <Mark />
            </div>
            <p className="mb-2 text-[10px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
              A little less friction
            </p>
            <h1 className="text-2xl font-medium tracking-tight">What are you working on?</h1>
            <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
              A fresh conversation. The right model for each message.
              <br />
              Every answer, accounted for.
            </p>
            <div className="mt-7 flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] text-muted-foreground">
              <Sparkles className="size-3" />
              {modelName}
              <span className="mx-1 opacity-40">/</span>
              <span>Ctrl+K to change</span>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-[780px] px-8 pt-8 pb-12 max-[800px]:px-5">
            <div className="mb-7 flex items-center justify-center gap-3 text-[10px] text-muted-foreground">
              <span className="h-px w-8 bg-border" />
              {startedAt !== null && startedLabel(startedAt)}
              <span className="h-px w-8 bg-border" />
            </div>
            {messages.map((message) => (
              <div
                key={message.id}
                id={`message-${message.id}`}
                className={
                  focusId === message.id
                    ? "-mx-3 rounded-xl bg-amber-100/40 px-3 dark:bg-amber-500/10"
                    : undefined
                }
              >
                {message.summaryAbove && (
                  <div
                    className="my-8 flex items-center gap-3 font-mono text-[10px] text-muted-foreground"
                    role="separator"
                    aria-label="Earlier messages are summarized"
                  >
                    <div className="h-px flex-1 border-t border-dashed" />
                    <span className="text-center">
                      Above: sent to the model as a summary (files and the latest turns stay in
                      full)
                    </span>
                    <div className="h-px flex-1 border-t border-dashed" />
                  </div>
                )}
                {message.switchLabel && (
                  <div className="my-8 flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-center">{message.switchLabel}</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
                {message.role === "user" ? (
                  <div className="mb-8 ml-auto flex max-w-[86%] flex-col items-end">
                    {message.images && message.images.length > 0 && (
                      <div className="mb-2 flex flex-wrap justify-end gap-2">
                        {message.images.map((img) =>
                          img.kind === "document" ? (
                            <button
                              key={img.id}
                              type="button"
                              disabled={!onOpenFile}
                              aria-label={`Open ${img.name}`}
                              className="flex max-w-64 items-center gap-2 rounded-xl border bg-background px-3 py-2 text-left text-[11px] enabled:hover:bg-accent"
                              title={img.name}
                              onClick={() => onOpenFile?.(img.id)}
                            >
                              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                              <span className="truncate">{img.name}</span>
                            </button>
                          ) : img.url ? (
                            <img
                              key={img.id}
                              src={img.url}
                              alt={img.name}
                              title={img.name}
                              className="max-h-56 max-w-72 rounded-xl border object-contain"
                            />
                          ) : (
                            <span
                              key={img.id}
                              className="flex h-20 w-28 items-center justify-center rounded-xl border bg-muted px-2 text-center text-[10px] text-muted-foreground"
                            >
                              {img.name}
                            </span>
                          ),
                        )}
                      </div>
                    )}
                    {editing === message.id && onEdit ? (
                      <EditQuestion
                        initial={message.content}
                        onCancel={() => {
                          setEditing(null);
                        }}
                        onSend={(text) => {
                          setEditing(null);
                          onEdit(message.id, text);
                        }}
                      />
                    ) : (
                      message.content && (
                        <div className="self-stretch rounded-2xl rounded-tr-md border border-border/50 bg-muted/65 px-4 py-3.5 text-[13px] leading-[1.8] whitespace-pre-wrap">
                          {message.content}
                        </div>
                      )
                    )}
                    <div className="mt-1 flex items-center gap-1 pr-1 text-[10px] text-muted-foreground">
                      {message.branch && (
                        <BranchPicker
                          branch={message.branch}
                          label="question"
                          {...(onBranch && !busy
                            ? {
                                onStep: (step: -1 | 1) => {
                                  onBranch(message.id, step);
                                },
                              }
                            : {})}
                        />
                      )}
                      {onEdit &&
                        !busy &&
                        editing !== message.id &&
                        message.id !== "live-question" && (
                          <Tip label="Edit and send again (keeps this version)">
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Edit message"
                              onClick={() => {
                                setEditing(message.id);
                              }}
                            >
                              <Pencil />
                            </Button>
                          </Tip>
                        )}
                      <span className="ml-1">You</span>
                    </div>
                  </div>
                ) : (
                  <article className="mb-9">
                    <div className="mb-4 flex items-center gap-2">
                      <span className="flex size-6 items-center justify-center rounded-md border bg-background">
                        <Sparkles className="size-3" />
                      </span>
                      <span className="text-xs font-semibold">{message.providerName}</span>
                      <span className="text-[10px] text-muted-foreground">{message.model}</span>
                    </div>
                    {message.run && (
                      <RunCard
                        run={message.run}
                        busy={busy}
                        {...(onContinueRun ? { onContinue: onContinueRun } : {})}
                        {...(onUndoChange ? { onUndoChange } : {})}
                        {...(onUndoRun ? { onUndoRun } : {})}
                        {...(onApprove ? { onApprove } : {})}
                        {...(onPreviewChange ? { onPreviewChange } : {})}
                      />
                    )}
                    {message.content && (
                      <div
                        data-answer={message.id}
                        className="text-[13px] leading-[1.85] text-foreground/85"
                      >
                        {message.parts ? (
                          message.parts.map((part, i) =>
                            part.kind === "text" ? (
                              <Markdown key={i} content={part.text} />
                            ) : (
                              <ArtifactCard
                                key={i}
                                title={part.title}
                                type={part.type}
                                language={part.language}
                                writing={!part.complete}
                                open={openArtifact === part.key}
                                onOpen={() => onOpenArtifact?.(part.key)}
                              />
                            ),
                          )
                        ) : (
                          <Markdown content={message.content} />
                        )}
                        {message.status === "streaming" && (
                          <span
                            className="mt-2 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-foreground"
                            aria-label="Response streaming"
                          />
                        )}
                      </div>
                    )}
                    {message.searching && (
                      <p
                        role="status"
                        className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"
                      >
                        <Globe className="size-3 animate-pulse" />
                        Searching the web…
                      </p>
                    )}
                    {message.status === "streaming" && !message.content && !message.searching && (
                      <span
                        className="inline-block h-4 w-1.5 animate-pulse rounded-sm bg-foreground"
                        aria-label="Response streaming"
                      />
                    )}
                    {message.status === "error" && (
                      <div
                        role="alert"
                        className={`flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4 ${message.content ? "mt-4" : ""}`}
                      >
                        <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                        <div>
                          <p className="text-sm font-medium">Couldn’t complete this response</p>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {message.error}
                          </p>
                          <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
                            Retry response<Hint>Ctrl R</Hint>
                          </Button>
                        </div>
                      </div>
                    )}
                    {message.sources && message.sources.length > 0 && (
                      <nav aria-label="Sources" className="mt-4">
                        <p className="mb-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                          Sources
                        </p>
                        <ol className="space-y-1 text-[11px]">
                          {message.sources.map((s, i) => (
                            <li key={s.url} className="flex gap-2">
                              <span className="w-4 shrink-0 text-right font-mono text-muted-foreground">
                                {i + 1}
                              </span>
                              <a
                                href={s.url}
                                title={s.url}
                                onClick={(e) => {
                                  e.preventDefault();
                                  openExternal(s.url);
                                }}
                                className="truncate underline decoration-border underline-offset-4 hover:decoration-foreground"
                              >
                                {s.title ?? hostOf(s.url)}
                              </a>
                              {s.title && (
                                <span className="shrink-0 text-muted-foreground">
                                  {hostOf(s.url)}
                                </span>
                              )}
                            </li>
                          ))}
                        </ol>
                      </nav>
                    )}
                    {message.fileSources && message.fileSources.length > 0 && (
                      <div className="mt-4" aria-label="From your files and chats">
                        <p className="mb-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                          From your files and chats
                        </p>
                        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                          {message.fileSources.map((source, i) => (
                            <li
                              key={`${String(i)}-${source.label}`}
                              className="flex items-center gap-1.5"
                            >
                              <FileText className="size-3 shrink-0" />
                              {onOpenSource && source.chunkId ? (
                                <button
                                  className="text-left underline-offset-2 hover:text-foreground hover:underline"
                                  onClick={() => {
                                    if (source.chunkId) onOpenSource(source.chunkId);
                                  }}
                                >
                                  {source.label}
                                </button>
                              ) : (
                                source.label
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {message.notice && (
                      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <CircleAlert className="size-3" />
                        {message.notice}
                      </p>
                    )}
                    {message.status === "stopped" && (
                      <span className="mt-4 inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[10px] text-muted-foreground">
                        <Square className="size-2.5" />
                        Stopped
                      </span>
                    )}
                    {message.status !== "streaming" && (
                      <div className="flex flex-wrap items-center gap-x-3">
                        {message.route && <RouteBadge route={message.route} />}
                        <CostBadge message={message} />
                        {message.memories && message.memories.length > 0 && (
                          <MemoryBadge memories={message.memories} />
                        )}
                        {message.content && (
                          <div
                            className="mt-4 flex items-center gap-0.5"
                            role="group"
                            aria-label="Answer actions"
                          >
                            <Tip label={copied === message.id ? "Copied" : "Copy answer"}>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label="Copy answer"
                                onClick={() => {
                                  void navigator.clipboard.writeText(message.content).then(() => {
                                    setCopied(message.id);
                                  });
                                }}
                              >
                                {copied === message.id ? <Check /> : <Copy />}
                              </Button>
                            </Tip>
                            {onQuote && (
                              <Tip label="Quote in your reply">
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label="Quote in reply"
                                  onClick={() => {
                                    onQuote(message.content);
                                  }}
                                >
                                  <Quote />
                                </Button>
                              </Tip>
                            )}
                            {onRegenerate && !busy && (
                              <Tip label="New answer (keeps this one)">
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label="Regenerate answer"
                                  onClick={() => {
                                    onRegenerate(message.id);
                                  }}
                                >
                                  <RotateCcw />
                                </Button>
                              </Tip>
                            )}
                            {message.branch && (
                              <BranchPicker
                                branch={message.branch}
                                label="answer"
                                {...(onBranch && !busy
                                  ? {
                                      onStep: (step: -1 | 1) => {
                                        onBranch(message.id, step);
                                      },
                                    }
                                  : {})}
                              />
                            )}
                            {message.branch && onSideBySide && !busy && (
                              <Tip label="See this answer's versions side by side">
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label="Side by side"
                                  onClick={() => {
                                    onSideBySide(message.id);
                                  }}
                                >
                                  <Columns2 />
                                </Button>
                              </Tip>
                            )}
                            {onFeedback &&
                              (["up", "down"] as const).map((value) => {
                                const on = message.feedback === value;
                                const Icon = value === "up" ? ThumbsUp : ThumbsDown;
                                return (
                                  <Tip
                                    key={value}
                                    label={value === "up" ? "Good answer" : "Bad answer"}
                                  >
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      aria-label={value === "up" ? "Good answer" : "Bad answer"}
                                      aria-pressed={on}
                                      className={on ? "text-foreground" : "text-muted-foreground"}
                                      onClick={() => {
                                        onFeedback(message.id, on ? null : value);
                                      }}
                                    >
                                      <Icon className={on ? "fill-current" : ""} />
                                    </Button>
                                  </Tip>
                                );
                              })}
                          </div>
                        )}
                        {message.escalateTo && onEscalate && (
                          <Tip label="Ask the same question one tier up. This answer stays.">
                            <button
                              className={`mt-4 flex items-center gap-1 rounded py-1 text-[10px] leading-5 hover:text-foreground ${message.feedback === "down" ? "font-medium text-foreground" : "text-muted-foreground"}`}
                              onClick={onEscalate}
                            >
                              <ArrowUp className="size-3" />
                              {message.feedback === "down" ? "Not right? " : ""}Try a stronger model
                              ({message.escalateTo})
                            </button>
                          </Tip>
                        )}
                      </div>
                    )}
                  </article>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {away && (
        <Button
          variant="outline"
          size="icon-sm"
          className="absolute right-6 bottom-4 rounded-full bg-background shadow-md"
          aria-label="Scroll to latest message"
          onClick={() =>
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
          }
        >
          <ArrowDown />
        </Button>
      )}
    </div>
  );
}

/** RT-12's compare control: models that can answer, and the two or three chosen. */
export interface CompareView {
  options: { key: string; label: string }[];
  selected: string[];
  onChange: (keys: string[]) => void;
  /** What the chosen models would cost for this draft, e.g. "about $0.03". */
  estimate: (draft: string) => string | null;
}

export function Composer({
  model,
  models,
  streaming,
  missingKey,
  pickerOpen,
  onPickerOpen,
  onSelectModel,
  onSend,
  onStop,
  onSettings,
  attachments = [],
  blocked = null,
  onAddFiles,
  onRemoveAttachment,
  onAttachmentMode,
  onAttachmentSecrets,
  onAddLink,
  webSearch = null,
  onToggleWebSearch,
  code = false,
  onToggleCode,
  work = false,
  onToggleWork,
  folders = [],
  onAddFolder,
  onRemoveFolder,
  codeMode = "ask",
  onCodeMode,
  codeBranch = false,
  onCodeBranch,
  routing,
  insert,
  status = null,
  context,
  compare,
  prompts = [],
  onPickPrompt,
}: {
  model: ModelOption;
  models: ModelOption[];
  streaming: boolean;
  /** Provider name when the selected model's provider has no key yet. */
  missingKey: string | null;
  pickerOpen: boolean;
  onPickerOpen: (open: boolean) => void;
  onSelectModel: (model: ModelOption) => void;
  /** `thinkHarder`: maximum reasoning effort for this one message (RT-08). */
  onSend: (content: string, opts?: { thinkHarder: boolean }) => void;
  onStop: () => void;
  onSettings: () => void;
  attachments?: PendingAttachment[];
  /** Why sending is blocked right now (e.g. the model can't read images). */
  blocked?: string | null;
  onAddFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  /** Whole or searched, for a large text file (FK-03). */
  onAttachmentMode?: (id: string, mode: "whole" | "retrieval") => void;
  /** FK-11: remove the lines that look like secrets, or send the file as is. */
  onAttachmentSecrets?: (id: string, action: "remove" | "keep") => void;
  /** A pasted link: read the page and attach its text (FK-06). */
  onAddLink?: (url: string) => void;
  /** On / off, or null when the selected model can't search. */
  webSearch?: boolean | null;
  onToggleWebSearch?: () => void;
  /**
   * WF-02: the folders this chat can work in (its own, then its project's). `own` ones can be
   * removed here; a project's are managed in its settings.
   */
  folders?: { id: string; name: string; path: string; own: boolean }[];
  onAddFolder?: () => void;
  onRemoveFolder?: (id: string) => void;
  /** M6: the next message starts a coding run in the chat's folders. */
  code?: boolean;
  onToggleCode?: () => void;
  /** WF-01: the next message starts a Work run (documents, deliverables) instead. */
  work?: boolean;
  onToggleWork?: () => void;
  /** CA-04: what that run may do. */
  codeMode?: "plan" | "ask" | "auto_edit";
  onCodeMode?: (mode: "plan" | "ask" | "auto_edit") => void;
  /** CA-05: start the run on a branch of its own. */
  codeBranch?: boolean;
  onCodeBranch?: (on: boolean) => void;
  /** Auto and pinned tiers (RT-01); without it the picker lists models only. */
  routing?: RoutingView;
  /** Text to add to the draft (a quoted answer); a new `key` adds it again. */
  insert?: { text: string; key: number } | null;
  /** A provider problem to mention under the composer (MM-06). */
  status?: string | null;
  /** How full the context is: tokens the next turn sends, the model's window, and where
   * summarizing starts (PM-06). */
  context?: { used: number; window: number; summarizeAt: number };
  /** RT-12: send the next message to two or three models and compare the answers. */
  compare?: CompareView;
  /** CH-12: saved prompts, offered when the message starts with "/". */
  prompts?: { id: string; name: string }[];
  onPickPrompt?: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const processing = attachments.some((a) => a.status === "processing");
  const ready = attachments.some((a) => a.status === "ready");
  const canSend = (text.trim() !== "" || ready) && !processing && !blocked;
  const addFiles = (list: FileList | null | undefined) => {
    const files = Array.from(list ?? []);
    if (files.length > 0) onAddFiles?.(files);
  };
  const [search, setSearch] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const inserted = useRef(0);
  useEffect(() => {
    if (!insert || insert.key === inserted.current) return;
    inserted.current = insert.key;
    setText((draft) => (draft.trim() ? `${draft.trimEnd()}\n\n${insert.text}` : insert.text));
    field.current?.focus();
  }, [insert]);
  useEffect(() => {
    if (field.current) {
      field.current.style.height = "auto";
      field.current.style.height = `${String(Math.min(field.current.scrollHeight, window.innerHeight * 0.3))}px`;
    }
  }, [text]);
  const [thinkHarder, setThinkHarder] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  // CH-12: "/" at the start of an empty message lists saved prompts, filtered by what follows.
  const slash = /^\/(\S*)$/.exec(text);
  const slashMatches =
    slash && onPickPrompt
      ? prompts
          .map((p) => ({ p, score: fuzzyScore(slash[1] ?? "", p.name) }))
          .filter((x) => x.score !== null)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .slice(0, 8)
          .map((x) => x.p)
      : [];
  const pickPrompt = (id: string) => {
    setText("");
    onPickPrompt?.(id);
  };
  const comparing = (compare?.selected.length ?? 0) >= 2;
  const send = () => {
    if (!canSend || streaming || missingKey) return;
    onSend(text.trim(), { thinkHarder });
    setText("");
    setThinkHarder(false);
    field.current?.focus();
  };
  const modelPinned = !routing || routing.selected === null;
  const preview = routing?.selected === "auto" ? routing.preview(text) : null;
  const modeLabel = routing?.selected ? MODE_LABELS[routing.selected] : null;
  const filtered = models.filter((item) =>
    `${item.providerName} ${item.name} ${item.id}`.toLowerCase().includes(search.toLowerCase()),
  );
  // F4: the row never overflows. When it would, run mode, New branch, Think and Compare move into
  // "More" (level 1); if it still would, Search goes there too (level 2). Each level goes back
  // once there's room for what it took away (`needed`), and the row measures again whenever what
  // it holds changes.
  const row = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const needed = useRef<number[]>([]);
  const holds = [
    folders.map((f) => f.id).join(","),
    code,
    work,
    codeMode,
    Boolean(compare && compare.options.length >= 2),
    modeLabel ?? model.name,
    preview,
  ].join("|");
  const [measuredFor, setMeasuredFor] = useState(holds);
  if (measuredFor !== holds) {
    setMeasuredFor(holds);
    setLevel(0);
  }
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const fit = () => {
      if (level < 2 && el.scrollWidth > el.clientWidth + 1) {
        needed.current[level] = el.scrollWidth;
        setLevel(level + 1);
      } else if (level > 0 && el.clientWidth >= (needed.current[level - 1] ?? Infinity)) {
        setLevel(level - 1);
      }
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => {
      watch.disconnect();
    };
  });
  const collapsed = level > 0;
  const tight = level > 1;
  /** Web search on or off: in the row, or (`menu`) in "More" when even the main row is tight. */
  const searchButton = (menu: boolean) =>
    onToggleWebSearch && (
      <Tip
        label={
          webSearch === null
            ? `${model.name} can't search the web`
            : webSearch
              ? "Web search on: the model may search (billed per search)"
              : "Web search off"
        }
      >
        <Button
          variant="ghost"
          size="sm"
          aria-label="Search the web"
          aria-pressed={webSearch === true}
          disabled={webSearch === null}
          className={`shrink-0 gap-1.5 text-xs ${menu ? "justify-start" : ""} ${webSearch ? "bg-accent text-foreground" : "text-muted-foreground"}`}
          onClick={onToggleWebSearch}
        >
          <Globe className="size-3.5" />
          <span className={menu ? "" : "hidden min-[900px]:inline"}>
            {menu ? `Search the web${webSearch ? " · on" : ""}` : "Search"}
          </span>
        </Button>
      </Tip>
    );
  const showMode = Boolean(onToggleCode && (code || work) && onCodeMode);
  const showBranch = Boolean(onToggleCode && code && onCodeBranch && codeMode !== "plan");
  const showCompare = Boolean(compare && compare.options.length >= 2);
  const compareList = compare && (
    <>
      <span className="mb-1 text-[11px] text-muted-foreground">
        Pick two or three; the next message goes to each.
      </span>
      {compare.options.map((o) => {
        const on = compare.selected.includes(o.key);
        return (
          <label key={o.key} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={on}
              disabled={!on && compare.selected.length >= 3}
              onChange={() => {
                compare.onChange(
                  on ? compare.selected.filter((k) => k !== o.key) : [...compare.selected, o.key],
                );
              }}
            />
            {o.label}
          </label>
        );
      })}
    </>
  );
  /** Run mode, New branch, Think and Compare: in the row, or (`menu`) listed in "More". */
  const extras = (menu: boolean) => (
    <>
      {showMode && onCodeMode && (
        <select
          aria-label="What the coding run may do"
          className="h-7 shrink-0 rounded-md border border-input bg-background px-1.5 text-xs"
          value={codeMode}
          onChange={(e) => {
            const v = e.target.value;
            onCodeMode(v === "auto_edit" ? "auto_edit" : v === "plan" ? "plan" : "ask");
          }}
        >
          <option value="plan">Read-only</option>
          <option value="ask">Ask first</option>
          <option value="auto_edit">Can edit files</option>
        </select>
      )}
      {showBranch && onCodeBranch && (
        <label className="flex shrink-0 items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
          <input
            type="checkbox"
            checked={codeBranch}
            onChange={(e) => {
              onCodeBranch(e.target.checked);
            }}
          />
          New branch
        </label>
      )}
      <Tip
        label={
          thinkHarder
            ? "Think harder: maximum reasoning for this message (slower, more output tokens)"
            : "Think harder for this message"
        }
      >
        <Button
          variant="ghost"
          size="sm"
          aria-label="Think harder"
          aria-pressed={thinkHarder}
          className={`shrink-0 gap-1.5 text-xs ${menu ? "justify-start" : ""} ${thinkHarder ? "bg-accent text-foreground" : "text-muted-foreground"}`}
          onClick={() => {
            setThinkHarder((on) => !on);
          }}
        >
          <Brain className="size-3.5" />
          <span className={menu ? "" : "hidden min-[900px]:inline"}>
            {menu ? `Think harder${thinkHarder ? " · on" : ""}` : "Think"}
          </span>
        </Button>
      </Tip>
      {showCompare &&
        compare &&
        (menu ? (
          <div
            role="group"
            aria-label="Models to compare"
            className="flex flex-col gap-1 border-t pt-2 text-xs"
          >
            <span className="flex items-center gap-1.5 font-medium">
              <Columns2 className="size-3.5" />
              Compare{comparing ? ` · ${String(compare.selected.length)}` : ""}
            </span>
            {compareList}
          </div>
        ) : (
          <span className="relative shrink-0">
            <Tip label="Send the next message to two or three models and compare the answers">
              <Button
                variant="ghost"
                size="sm"
                aria-label="Compare models"
                aria-expanded={compareOpen}
                aria-pressed={comparing}
                className={`gap-1.5 text-xs ${comparing ? "bg-accent text-foreground" : "text-muted-foreground"}`}
                onClick={() => {
                  setCompareOpen((o) => !o);
                }}
              >
                <Columns2 className="size-3.5" />
                <span className="hidden min-[900px]:inline">
                  Compare{comparing ? ` · ${String(compare.selected.length)}` : ""}
                </span>
              </Button>
            </Tip>
          </span>
        ))}
    </>
  );
  // Something in "More" is on, so its button says so.
  const moreOn = thinkHarder || comparing || (tight && webSearch === true);
  const moreMenu = (
    <Popover.Root open={moreOpen} onOpenChange={setMoreOpen}>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="More options"
          className={`shrink-0 gap-1.5 text-xs ${moreOn ? "bg-accent text-foreground" : "text-muted-foreground"}`}
        >
          <Ellipsis className="size-3.5" />
          {moreOn && <span className="size-1.5 rounded-full bg-foreground" aria-hidden />}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          side="top"
          sideOffset={8}
          collisionPadding={16}
          aria-label="More options"
          className="z-30 flex w-64 flex-col gap-2 rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg"
        >
          {tight && searchButton(true)}
          {extras(true)}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
  return (
    <footer className="shrink-0 px-8 pt-2 pb-3 max-[800px]:px-5">
      <div
        className={`mx-auto max-w-[716px] rounded-2xl border bg-background p-3 shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/10 ${dragging ? "border-ring ring-2 ring-ring/20" : "border-input"}`}
        onDragOver={(e) => {
          if (!onAddFiles || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={(e) => {
          if (!onAddFiles) return;
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {attachments.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-2" aria-label="Attachments">
            {attachments.map((a) => (
              <li
                key={a.id}
                className={`flex max-w-96 items-center gap-2 rounded-lg border py-1 pr-1 pl-1 text-[11px] ${a.status === "error" ? "border-destructive/40 text-destructive" : ""}`}
              >
                {a.url ? (
                  <img src={a.url} alt="" className="size-9 shrink-0 rounded object-cover" />
                ) : (
                  <span className="flex size-9 shrink-0 items-center justify-center rounded bg-muted">
                    {a.status === "processing" ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : a.status === "error" ? (
                      <CircleAlert className="size-3.5" />
                    ) : (
                      <FileText className="size-3.5" />
                    )}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate font-medium">{a.name}</span>
                  <span
                    className={`block truncate font-mono text-[10px] ${a.large ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
                    title={
                      a.large
                        ? "Large file: it's resent with every message in this chat"
                        : undefined
                    }
                  >
                    {a.status === "error"
                      ? a.error
                      : a.status === "processing"
                        ? "Preparing…"
                        : a.detail}
                  </span>
                </span>
                {a.mode && onAttachmentMode && (
                  <span
                    className="flex shrink-0 rounded-md border p-0.5 text-[10px]"
                    role="group"
                    aria-label={`How ${a.name} is sent`}
                  >
                    {(["retrieval", "whole"] as const).map((m) => (
                      <button
                        key={m}
                        aria-pressed={a.mode === m}
                        disabled={m === "whole" && !a.canWhole}
                        title={
                          m === "retrieval"
                            ? "Send only the parts that match each question"
                            : a.canWhole
                              ? "Send the whole file with every message"
                              : "Too long to send whole"
                        }
                        className={`rounded px-1.5 py-0.5 disabled:opacity-40 ${a.mode === m ? "bg-accent font-medium" : "text-muted-foreground"}`}
                        onClick={() => {
                          onAttachmentMode(a.id, m);
                        }}
                      >
                        {m === "retrieval" ? "Search" : "Whole"}
                      </button>
                    ))}
                  </span>
                )}
                {a.secrets && onAttachmentSecrets && (
                  <span
                    role="alert"
                    className="flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px]"
                    title={`Looks like it holds ${a.secrets.summary}`}
                  >
                    <CircleAlert className="size-3 text-amber-600" />
                    <span className="max-w-40 truncate">Secrets? {a.secrets.summary}</span>
                    {a.secrets.canRemove && (
                      <button
                        className="rounded px-1 font-medium hover:bg-accent"
                        onClick={() => {
                          onAttachmentSecrets(a.id, "remove");
                        }}
                      >
                        Remove those lines
                      </button>
                    )}
                    <button
                      className="rounded px-1 hover:bg-accent"
                      onClick={() => {
                        onAttachmentSecrets(a.id, "keep");
                      }}
                    >
                      Send anyway
                    </button>
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => onRemoveAttachment?.(a.id)}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {missingKey ? (
          <button
            className="flex w-full items-center gap-2 px-1 py-3 text-left text-sm text-muted-foreground underline underline-offset-4"
            onClick={onSettings}
          >
            Add {/^[AEIOU]/.test(missingKey) ? "an" : "a"} {missingKey} key in Settings
            <CircleAlert className="size-3.5" />
          </button>
        ) : (
          <textarea
            ref={field}
            aria-label="Message"
            placeholder="Ask anything, or pick up where you left off…"
            rows={2}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
            onPaste={(e) => {
              if (onAddFiles && e.clipboardData.files.length > 0) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
                return;
              }
              // A pasted link is also read as an attachment; the link text stays in the message.
              const pasted = e.clipboardData.getData("text/plain").trim();
              if (onAddLink && /^https?:\/\/\S+$/i.test(pasted)) onAddLink(pasted);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const first = slashMatches[0];
                if (first) pickPrompt(first.id);
                else send();
              }
            }}
            className="block max-h-[30dvh] min-h-14 w-full resize-none bg-transparent px-1 py-1 text-[13px] leading-6 outline-none placeholder:text-muted-foreground/75"
          />
        )}
        {slashMatches.length > 0 && (
          <ul
            role="listbox"
            aria-label="Saved prompts"
            className="mb-1 max-h-48 overflow-y-auto rounded-lg border bg-popover p-1 text-xs"
          >
            {slashMatches.map((p, i) => (
              <li
                key={p.id}
                role="option"
                aria-selected={i === 0}
                className={`cursor-pointer rounded px-2 py-1.5 ${i === 0 ? "bg-accent" : "hover:bg-accent/60"}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickPrompt(p.id);
                }}
              >
                {p.name}
              </li>
            ))}
          </ul>
        )}
        {blocked && (
          <p role="status" className="px-1 pb-1 text-[11px] text-destructive">
            {blocked}
          </p>
        )}
        <div className="relative mt-1 flex items-center justify-between gap-2">
          <div
            ref={row}
            data-composer-row
            className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
          >
            {onAddFiles && (
              <>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  accept={`image/png,image/jpeg,image/webp,image/gif,${DOCUMENT_ACCEPT}`}
                  className="hidden"
                  aria-label="Attach files"
                  onChange={(e) => {
                    addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <Tip label="Attach images, PDFs, Word, text or code · or paste / drop them">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Attach a file"
                    onClick={() => picker.current?.click()}
                  >
                    <Paperclip />
                  </Button>
                </Tip>
              </>
            )}
            <Popover.Root
              open={pickerOpen}
              onOpenChange={(open) => {
                onPickerOpen(open);
                if (!open) setSearch("");
              }}
            >
              <Popover.Trigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2 text-xs"
                  aria-label="Choose model (Ctrl+K)"
                >
                  <Sparkles className="size-3.5" />
                  <span>{modeLabel ?? model.name}</span>
                  {routing?.once && <span className="text-muted-foreground">· once</span>}
                  {preview && (
                    <span className="text-muted-foreground" aria-label={`Auto picks ${preview}`}>
                      → {preview}
                    </span>
                  )}
                  <ChevronDown className="size-3" />
                  <span className="ml-1 hidden min-[900px]:inline">
                    <Hint>Ctrl K</Hint>
                  </span>
                </Button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  align="start"
                  side="top"
                  sideOffset={12}
                  collisionPadding={16}
                  className="z-30 w-[390px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl"
                  aria-label="Model picker"
                  onKeyDown={(event) => {
                    const buttons = Array.from(
                      event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
                    );
                    const index = buttons.findIndex((button) => button === document.activeElement);
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      const next =
                        event.key === "ArrowDown"
                          ? index + 1
                          : index <= 0
                            ? buttons.length - 1
                            : index - 1;
                      buttons[next % buttons.length]?.focus();
                    }
                    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
                      event.preventDefault();
                      buttons[0]?.click();
                    }
                  }}
                >
                  <div className="flex items-center gap-2.5 border-b px-4 py-3">
                    <Search className="size-4 text-muted-foreground" />
                    <input
                      aria-label="Search models"
                      autoFocus
                      placeholder="Find a model…"
                      className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                      }}
                    />
                    <Hint>Esc</Hint>
                  </div>
                  {routing && !search && (
                    <div className="border-b p-2" role="group" aria-label="Routing">
                      {(["auto", "balanced", "best"] as const).map((choice) => (
                        <button
                          key={choice}
                          className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left outline-offset-[-2px] hover:bg-accent focus-visible:bg-accent ${routing.selected === choice ? "bg-accent/70" : ""}`}
                          onClick={() => {
                            routing.onSelect(choice);
                            onPickerOpen(false);
                            field.current?.focus();
                          }}
                        >
                          <span className="flex-1">
                            <span className="block text-xs font-medium">
                              {choice === "auto" ? "Auto" : `${MODE_LABELS[choice]} tier`}
                            </span>
                            <span className="mt-0.5 block text-[10px] text-muted-foreground">
                              {routing.descriptions[choice]}
                            </span>
                          </span>
                          <span className="w-4">
                            {routing.selected === choice && <Check className="size-3.5" />}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex justify-between px-4 pt-3 text-[9px] tracking-wide text-muted-foreground uppercase">
                    <span>{routing ? "Or pin a model" : "Model / context"}</span>
                    <span>Input / output per 1M</span>
                  </div>
                  <div className="max-h-[45dvh] overflow-y-auto p-2">
                    {[...new Set(models.map((item) => item.providerName))].map((provider) => (
                      <div key={provider}>
                        {filtered.some((item) => item.providerName === provider) && (
                          <h3 className="px-2 pt-3 pb-1.5 text-[10px] font-semibold text-muted-foreground">
                            {provider}
                          </h3>
                        )}
                        {filtered
                          .filter((item) => item.providerName === provider)
                          .map((item) => (
                            <button
                              key={item.id}
                              className={`flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-left outline-offset-[-2px] hover:bg-accent focus-visible:bg-accent ${modelPinned && item.id === model.id ? "bg-accent/70" : ""}`}
                              onClick={() => {
                                onSelectModel(item);
                                onPickerOpen(false);
                                setSearch("");
                                field.current?.focus();
                              }}
                            >
                              <span className="flex-1">
                                <span className="block text-xs font-medium">{item.name}</span>
                                <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                                  {item.context} context
                                </span>
                              </span>
                              <span className="font-mono text-[10px] text-muted-foreground">
                                ${item.inputPrice.toFixed(2)} / ${item.outputPrice.toFixed(2)}
                              </span>
                              <span className="w-4">
                                {modelPinned && item.id === model.id && (
                                  <Check className="size-3.5" />
                                )}
                              </span>
                            </button>
                          ))}
                      </div>
                    ))}
                    {filtered.length === 0 && (
                      <p className="p-6 text-center text-sm text-muted-foreground">
                        No models found.
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 border-t bg-muted/30 px-4 py-2.5 text-[10px] text-muted-foreground">
                    <Command className="size-3" />
                    <span className="flex-1">Switch models anytime. Your history comes along.</span>
                    {routing?.onOnce && (
                      <label className="flex items-center gap-1.5 text-foreground">
                        <input
                          type="checkbox"
                          aria-label="Next message only"
                          checked={routing.once ?? false}
                          onChange={(e) => {
                            routing.onOnce?.(e.target.checked);
                          }}
                        />
                        Next message only
                      </label>
                    )}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            {!tight && searchButton(false)}
            {folders.map((f) => (
              <span
                key={f.id}
                className="flex min-w-11 max-w-40 shrink items-center gap-1 overflow-hidden rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                title={f.own ? f.path : `${f.path} (from the project)`}
              >
                <FolderOpen className="size-3 shrink-0" />
                <span className="truncate">{f.name}</span>
                {f.own && onRemoveFolder && (
                  <button
                    type="button"
                    aria-label={`Remove folder ${f.name}`}
                    className="shrink-0 hover:text-foreground"
                    onClick={() => {
                      onRemoveFolder(f.id);
                    }}
                  >
                    <X className="size-3" />
                  </button>
                )}
              </span>
            ))}
            {onAddFolder && (
              <Tip label="Pick a folder on this computer for this chat to work in">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Add a folder"
                  className="gap-1.5 text-xs text-muted-foreground"
                  onClick={onAddFolder}
                >
                  <FolderPlus className="size-3.5" />
                  {folders.length === 0 && (
                    <span className="hidden min-[900px]:inline">Folder</span>
                  )}
                </Button>
              </Tip>
            )}
            {onToggleCode && (
              <Tip
                label={
                  code
                    ? "Code on: the next message starts a run that works in this chat's folders"
                    : "Code off"
                }
              >
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Coding run"
                  aria-pressed={code}
                  className={`gap-1.5 text-xs ${code ? "bg-accent text-foreground" : "text-muted-foreground"}`}
                  onClick={onToggleCode}
                >
                  <SquareTerminal className="size-3.5" />
                  <span className="hidden min-[900px]:inline">Code</span>
                </Button>
              </Tip>
            )}
            {onToggleWork && (
              <Tip
                label={
                  work
                    ? "Work on: the next message starts a run on the documents in this chat's folders"
                    : "Work off"
                }
              >
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Work run"
                  aria-pressed={work}
                  className={`gap-1.5 text-xs ${work ? "bg-accent text-foreground" : "text-muted-foreground"}`}
                  onClick={onToggleWork}
                >
                  <Briefcase className="size-3.5" />
                  <span className="hidden min-[900px]:inline">Work</span>
                </Button>
              </Tip>
            )}
            {!collapsed && extras(false)}
          </div>
          {/* Outside the clipped row, so it can't be cut off itself. */}
          {collapsed && moreMenu}
          {/* Outside the row, which clips what spills out of it. */}
          {!collapsed && showCompare && compareOpen && (
            <span
              role="group"
              aria-label="Models to compare"
              className="absolute bottom-full left-0 z-30 mb-2 flex w-64 flex-col gap-1 rounded-lg border bg-popover p-2 text-xs shadow-lg"
            >
              {compareList}
            </span>
          )}
          {streaming ? (
            <Button size="sm" variant="outline" className="shrink-0" onClick={onStop}>
              <Square className="size-3 fill-current" />
              Stop<Hint>Esc</Hint>
            </Button>
          ) : (
            <Tip label="Send message · Enter">
              <Button
                size="icon"
                className="shrink-0 rounded-xl"
                aria-label="Send message (Enter)"
                disabled={Boolean(missingKey) || !canSend}
                onClick={send}
              >
                <ArrowUp className="size-4" />
              </Button>
            </Tip>
          )}
        </div>
      </div>
      <div className="mx-auto mt-2.5 flex max-w-[716px] items-center justify-between gap-2 px-1 text-[9px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {streaming ? (
            <>
              <LoaderCircle className="size-2.5 animate-spin" />
              Generating response
            </>
          ) : status ? (
            <span
              role="status"
              className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400"
            >
              <CircleAlert className="size-2.5" />
              {status}
            </span>
          ) : compare && comparing ? (
            <span aria-label="Compare cost" className="flex items-center gap-1.5">
              <Columns2 className="size-2.5" />
              Sends to {compare.selected.length} models
              {compare.estimate(text) ? ` · ${compare.estimate(text) ?? ""} in all` : ""}
            </span>
          ) : (
            <>
              <span className="size-1 rounded-full bg-muted-foreground/60" />
              Your keys. Your conversations.
            </>
          )}
        </span>
        {context && context.used > 0 && (
          <Tip
            label={`About ${number(context.used)} tokens go to the model with each message. Above ${compact(context.summarizeAt)}, older turns are sent as a summary.`}
          >
            <span
              tabIndex={0}
              aria-label="Context used"
              className={`flex items-center gap-1.5 font-mono ${context.used >= context.summarizeAt * 0.8 ? "text-amber-700 dark:text-amber-400" : ""}`}
            >
              <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full bg-current"
                  style={{
                    width: `${String(Math.min(100, (context.used / context.window) * 100))}%`,
                  }}
                />
              </span>
              {compact(context.used)} / {compact(context.window)}
            </span>
          </Tip>
        )}
        <span className="flex items-center gap-1.5">
          <CornerDownLeft className="size-2.5" />
          Enter to send<span className="mx-1 opacity-30">/</span>Shift+Enter for a new line
        </span>
      </div>
    </footer>
  );
}

const RUN_STATUS: Record<RunView["status"], string> = {
  running: "Working",
  paused: "Paused",
  done: "Done",
  stopped: "Stopped",
  error: "Failed",
};

/**
 * WF-06: a reorganisation to approve: every move, each with a box (all ticked), the folders
 * that result, and Allow all, Allow the ticked ones, or Deny. Nothing is deleted.
 */
function OrganisePlan({
  plan,
  onAnswer,
}: {
  plan: { moves: { from: string; to: string }[]; reason: string | null };
  onAnswer: (a: "yes" | "no" | { keep: number[] }) => void;
}) {
  const [kept, setKept] = useState<boolean[]>(() => plan.moves.map(() => true));
  const n = kept.filter(Boolean).length;
  const folders = [
    ...new Set(
      plan.moves.map((m) => (m.to.includes("/") ? m.to.slice(0, m.to.lastIndexOf("/")) : "(top)")),
    ),
  ].sort();
  return (
    <div
      role="alertdialog"
      aria-label="Reorganise these files?"
      className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-[11px]"
    >
      <p className="mb-1 font-medium">
        Move {String(plan.moves.length)} file{plan.moves.length === 1 ? "" : "s"}? Nothing is
        deleted, and Undo puts them all back.
      </p>
      {plan.reason && <p className="mb-1 text-muted-foreground">{plan.reason}</p>}
      <p className="mb-1 text-muted-foreground">Into: {folders.join(", ")}</p>
      <ul className="mb-2 max-h-64 space-y-0.5 overflow-auto rounded border bg-background p-1.5 font-mono">
        {plan.moves.map((m, i) => (
          <li key={`${m.from}>${m.to}`}>
            <label className="flex items-start gap-1.5">
              <input
                type="checkbox"
                checked={kept[i] ?? false}
                aria-label={`Move ${m.from} to ${m.to}`}
                onChange={(e) => {
                  const on = e.target.checked;
                  setKept((k) => k.map((v, j) => (j === i ? on : v)));
                }}
              />
              <span className="min-w-0 break-all">
                {m.from} <span className="text-muted-foreground">→</span> {m.to}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          size="xs"
          onClick={() => {
            onAnswer("yes");
          }}
        >
          Allow all
        </Button>
        {n < plan.moves.length && n > 0 && (
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              onAnswer({ keep: kept.flatMap((v, i) => (v ? [i] : [])) });
            }}
          >
            Allow {String(n)} ticked
          </Button>
        )}
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            onAnswer("no");
          }}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

/**
 * A coding run on its answer (M6): what it did, step by step, and what it cost against its cap.
 * Paused at the cap or stopped, it can go on from where it was.
 */
function RunCard({
  run,
  busy,
  onContinue,
  onUndoChange,
  onUndoRun,
  onApprove,
  onPreviewChange,
}: {
  run: RunView;
  busy: boolean;
  /** WF-05: opens a changed file in the side panel. */
  onPreviewChange?: (changeId: string) => void;
  onApprove?: (runId: string, answer: "yes" | "always" | "no" | { keep: number[] }) => void;
  onContinue?: (runId: string, raise: boolean) => void;
  onUndoChange?: (changeId: string) => void;
  onUndoRun?: (runId: string) => void;
}) {
  const live = run.status === "running";
  const [shown, setShown] = useState<string | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const applied = run.changes.filter((c) => !c.undone);
  return (
    <section aria-label={run.title} className="mb-4 rounded-xl border bg-muted/30 px-3 py-2.5">
      <div className="flex items-center gap-2 text-[11px]">
        <SquareTerminal className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{run.title}</span>
        <span className="text-muted-foreground">{run.modeLabel}</span>
        {run.branch && (
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            on {run.branch}
          </span>
        )}
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] ${run.status === "error" ? "bg-destructive/10 text-destructive" : run.status === "paused" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground"}`}
        >
          {RUN_STATUS[run.status]}
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground tabular-nums">
          {run.costLabel}
        </span>
      </div>
      {(run.steps.length > 0 || run.streaming) && (
        <ol className="mt-2 space-y-1 border-l pl-3 text-[11px]">
          {run.steps.map((s) =>
            s.kind === "tool" ? (
              <li key={s.id} className="flex items-start gap-1.5">
                {s.label.startsWith("Searched") ? (
                  <Search className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                ) : s.label.startsWith("Listed") ? (
                  <FolderTree className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <FileText className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  {s.output === undefined ? (
                    <span className="font-mono break-all">{s.label}</span>
                  ) : (
                    <button
                      type="button"
                      aria-expanded={openStep === s.id}
                      className="text-left font-mono break-all hover:underline"
                      onClick={() => {
                        setOpenStep(openStep === s.id ? null : s.id);
                      }}
                    >
                      {s.label}
                    </button>
                  )}
                  {s.error && <span className="ml-1.5 text-destructive">{s.error}</span>}
                  {s.output !== undefined && openStep === s.id && (
                    <pre
                      aria-label={`Output of ${s.label}`}
                      className="mt-1 max-h-80 overflow-auto rounded border bg-background px-2 py-1 font-mono text-[11px] whitespace-pre-wrap"
                    >
                      {s.output}
                    </pre>
                  )}
                </span>
              </li>
            ) : (
              <li key={s.id} className="whitespace-pre-wrap text-muted-foreground">
                {s.label}
              </li>
            ),
          )}
          {run.streaming && (
            <li className="whitespace-pre-wrap text-muted-foreground">{run.streaming}</li>
          )}
        </ol>
      )}
      {run.approval?.kind === "organise" && onApprove && (
        <OrganisePlan
          key={run.approval.moves.map((m) => m.from).join("|")}
          plan={run.approval}
          onAnswer={(a) => {
            onApprove(run.id, a);
          }}
        />
      )}
      {run.approval?.kind === "network" && onApprove && (
        <div
          role="alertdialog"
          aria-label="Allow the network?"
          className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-[11px]"
        >
          <p className="mb-1 font-medium">This command seems to need the network:</p>
          <pre className="mb-2 overflow-x-auto rounded bg-background px-2 py-1 font-mono text-[11px] whitespace-pre-wrap">
            {run.approval.command}
          </pre>
          <p className="mb-2 text-muted-foreground">
            Commands run sandboxed with no network unless you allow it. Allowing runs it again.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              onClick={() => {
                onApprove(run.id, "yes");
              }}
            >
              Allow for this chat
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                onApprove(run.id, "always");
              }}
            >
              Allow for this folder
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                onApprove(run.id, "no");
              }}
            >
              No
            </Button>
          </div>
        </div>
      )}
      {run.approval &&
        run.approval.kind !== "organise" &&
        run.approval.kind !== "network" &&
        onApprove && (
          <div
            role="alertdialog"
            aria-label={
              run.approval.kind === "command"
                ? "Run this command?"
                : run.approval.kind === "git"
                  ? "Go ahead with git?"
                  : "Make this change?"
            }
            className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-[11px]"
          >
            {run.approval.kind === "command" ? (
              <>
                <p className="mb-1 font-medium">Run this command in this chat&apos;s folder?</p>
                <pre className="mb-2 overflow-x-auto rounded bg-background px-2 py-1 font-mono text-[11px] whitespace-pre-wrap">
                  {run.approval.command}
                </pre>
                {run.approval.destructive && (
                  <p className="mb-2 text-destructive">
                    This {run.approval.destructive}, so it asks every time.
                  </p>
                )}
                {run.approval.unsandboxed && (
                  <p className="mb-2 text-amber-700 dark:text-amber-400">
                    No sandbox on this computer: it runs with your full rights, and can change files
                    outside this chat&apos;s folders.
                  </p>
                )}
              </>
            ) : run.approval.kind === "git" ? (
              <>
                <p className="mb-1 font-medium">{run.approval.summary}?</p>
                {run.approval.remote && (
                  <p className="mb-2 text-amber-700 dark:text-amber-400">
                    This goes to GitHub, outside this computer.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="mb-1 font-medium">{run.approval.change.label}?</p>
                {run.approval.change.lines.length > 0 && (
                  <div className="mb-2 max-h-80 overflow-auto rounded border bg-background">
                    <DiffView lines={run.approval.change.lines} />
                  </div>
                )}
              </>
            )}
            <div className="flex gap-2">
              <Button
                size="xs"
                onClick={() => {
                  onApprove(run.id, "yes");
                }}
              >
                Allow
              </Button>
              {run.approval.kind === "command" && !run.approval.destructive && run.inProject && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    onApprove(run.id, "always");
                  }}
                >
                  Always allow in this project
                </Button>
              )}
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  onApprove(run.id, "no");
                }}
              >
                Deny
              </Button>
            </div>
          </div>
        )}
      {live && !run.streaming && (
        <p
          role="status"
          className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"
        >
          <LoaderCircle className="size-3 animate-spin" />
          Working…
        </p>
      )}
      {run.changes.length > 0 && (
        <div className="mt-2 border-t pt-2" aria-label="Files changed">
          <div className="mb-1 flex items-center gap-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Files changed
            {onUndoRun && applied.length > 1 && !live && (
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto normal-case"
                disabled={busy}
                onClick={() => {
                  onUndoRun(run.id);
                }}
              >
                Undo all
              </Button>
            )}
          </div>
          <ul className="space-y-1 text-[11px]">
            {run.changes.map((c) => (
              <li key={c.id}>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className={`min-w-0 truncate text-left font-mono hover:underline ${c.undone ? "text-muted-foreground line-through" : ""}`}
                    aria-expanded={shown === c.id}
                    onClick={() => {
                      setShown((s) => (s === c.id ? null : c.id));
                    }}
                  >
                    {c.label}
                  </button>
                  {c.lines.length > 0 && (
                    <span className="shrink-0 font-mono text-[10px] tabular-nums">
                      <span className="text-emerald-600 dark:text-emerald-400">+{c.added}</span>{" "}
                      <span className="text-destructive">−{c.removed}</span>
                    </span>
                  )}
                  {c.previewable && onPreviewChange && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="ml-auto"
                      onClick={() => {
                        onPreviewChange(c.id);
                      }}
                    >
                      Preview
                    </Button>
                  )}
                  {c.undone ? (
                    <span className="ml-auto text-[10px] text-muted-foreground">Undone</span>
                  ) : (
                    onUndoChange &&
                    !live && (
                      <Button
                        variant="ghost"
                        size="xs"
                        className={c.previewable && onPreviewChange ? "" : "ml-auto"}
                        disabled={busy}
                        onClick={() => {
                          onUndoChange(c.id);
                        }}
                      >
                        Undo
                      </Button>
                    )
                  )}
                </div>
                {shown === c.id && c.lines.length > 0 && (
                  <div className="mt-1 max-h-80 overflow-auto rounded border bg-background">
                    <DiffView lines={c.lines} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(run.status === "paused" || run.status === "stopped") && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          {run.note && <span className="text-muted-foreground">{run.note}</span>}
          {onContinue && (
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => {
                onContinue(run.id, run.status === "paused");
              }}
            >
              {run.status === "paused" ? "Continue (+$1.00)" : "Continue"}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
