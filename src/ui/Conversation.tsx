import { money, number } from "./format";
import {
  ArrowDown,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  Command,
  CornerDownLeft,
  LoaderCircle,
  FileText,
  Globe,
  Paperclip,
  Search,
  Square,
  Sparkles,
  X,
} from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DOCUMENT_ACCEPT } from "@/files/documents";
import { Markdown } from "./Markdown";
import { openExternal } from "./openExternal";
import { Hint, Mark, Tip } from "./primitives";
import type {
  MessageView,
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

const tokensIn = (u: UsageView) => u.freshInput + u.cachedInput + u.cacheWrite;

function CostBadge({ message }: { message: MessageView }) {
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

function MemoryBadge({ memories }: { memories: string[] }) {
  return (
    <Tip
      label={
        <div className="w-64 space-y-1.5 py-1">
          <p className="mb-2 font-medium">Memories sent with this answer</p>
          <ul className="space-y-1 text-[11px] leading-4">
            {memories.map((m, i) => (
              <li key={i}>· {m}</li>
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
}: {
  messages: MessageView[];
  /** Selected model, for the empty state. */
  modelName: string;
  /** When the conversation started (Unix ms). */
  startedAt: number | null;
  onRetry: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
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
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto scroll-smooth"
        onScroll={(e) => {
          const el = e.currentTarget;
          setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 240);
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
              <div key={message.id}>
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
                            <span
                              key={img.id}
                              className="flex max-w-64 items-center gap-2 rounded-xl border bg-background px-3 py-2 text-[11px]"
                              title={img.name}
                            >
                              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                              <span className="truncate">{img.name}</span>
                            </span>
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
                    {message.content && (
                      <div className="self-stretch rounded-2xl rounded-tr-md border border-border/50 bg-muted/65 px-4 py-3.5 text-[13px] leading-[1.8] whitespace-pre-wrap">
                        {message.content}
                      </div>
                    )}
                    <div className="mt-2 pr-1 text-right text-[10px] text-muted-foreground">
                      You
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
                    {message.content && (
                      <div className="text-[13px] leading-[1.85] text-foreground/85">
                        <Markdown content={message.content} />
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
  webSearch = null,
  onToggleWebSearch,
  routing,
}: {
  model: ModelOption;
  models: ModelOption[];
  streaming: boolean;
  /** Provider name when the selected model's provider has no key yet. */
  missingKey: string | null;
  pickerOpen: boolean;
  onPickerOpen: (open: boolean) => void;
  onSelectModel: (model: ModelOption) => void;
  onSend: (content: string) => void;
  onStop: () => void;
  onSettings: () => void;
  attachments?: PendingAttachment[];
  /** Why sending is blocked right now (e.g. the model can't read images). */
  blocked?: string | null;
  onAddFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  /** On / off, or null when the selected model can't search. */
  webSearch?: boolean | null;
  onToggleWebSearch?: () => void;
  /** Auto and pinned tiers (RT-01); without it the picker lists models only. */
  routing?: RoutingView;
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
  useEffect(() => {
    if (field.current) {
      field.current.style.height = "auto";
      field.current.style.height = `${String(Math.min(field.current.scrollHeight, window.innerHeight * 0.3))}px`;
    }
  }, [text]);
  const send = () => {
    if (!canSend || streaming || missingKey) return;
    onSend(text.trim());
    setText("");
    field.current?.focus();
  };
  const modelPinned = !routing || routing.selected === null;
  const preview = routing?.selected === "auto" ? routing.preview(text) : null;
  const modeLabel = routing?.selected ? MODE_LABELS[routing.selected] : null;
  const filtered = models.filter((item) =>
    `${item.providerName} ${item.name} ${item.id}`.toLowerCase().includes(search.toLowerCase()),
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
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            className="block max-h-[30dvh] min-h-14 w-full resize-none bg-transparent px-1 py-1 text-[13px] leading-6 outline-none placeholder:text-muted-foreground/75"
          />
        )}
        {blocked && (
          <p role="status" className="px-1 pb-1 text-[11px] text-destructive">
            {blocked}
          </p>
        )}
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
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
                    Switch models anytime. Your history comes along.
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            {onToggleWebSearch && (
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
                  className={`gap-1.5 text-xs ${webSearch ? "bg-accent text-foreground" : "text-muted-foreground"}`}
                  onClick={onToggleWebSearch}
                >
                  <Globe className="size-3.5" />
                  <span className="hidden min-[900px]:inline">Search</span>
                </Button>
              </Tip>
            )}
          </div>
          {streaming ? (
            <Button size="sm" variant="outline" onClick={onStop}>
              <Square className="size-3 fill-current" />
              Stop<Hint>Esc</Hint>
            </Button>
          ) : (
            <Tip label="Send message · Enter">
              <Button
                size="icon"
                className="rounded-xl"
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
          ) : (
            <>
              <span className="size-1 rounded-full bg-muted-foreground/60" />
              Your keys. Your conversations.
            </>
          )}
        </span>
        <span className="flex items-center gap-1.5">
          <CornerDownLeft className="size-2.5" />
          Enter to send<span className="mx-1 opacity-30">/</span>Shift+Enter for a new line
        </span>
      </div>
    </footer>
  );
}
