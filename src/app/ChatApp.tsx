// The chat screen: Astra's presentational components (src/ui) wired to storage, keys and the chat
// engine. All state that matters lives in SQLite; this holds only what's on screen.
import { CircleAlert, PanelLeft, Pencil, X } from "lucide-react";
import { Tooltip } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { findModel, type Catalog, type CatalogModel, type ProviderId } from "@/catalog/catalog";
import { priceToMicro } from "@/cost/cost";
import type { FilesApi } from "@/files/api";
import { LARGE_TEXT_TOKENS } from "@/files/documents";
import { imageTokens, type PreparedImage } from "@/files/images";
import { retryLast, sendMessage, type ChatDeps } from "@/chat/sendMessage";
import type { KeysApi, KeyTestResult } from "@/keys/api";
import type { ProviderAdapter } from "@/providers/types";
import type { Tenant } from "@/storage/defaults";
import { citationsForMessages, type Citation } from "@/storage/citations";
import { filesForMessages, type FileRecord } from "@/storage/files";
import { listMessages, type Message } from "@/storage/messages";
import { listRecentRequests, logRequest } from "@/storage/requestLog";
import type { SqlDb } from "@/storage/sql";
import type { UpdateApi } from "@/update/api";
import {
  createThread,
  deleteThread,
  listThreads,
  renameThread,
  setThreadWebSearch,
  type Thread,
} from "@/storage/threads";
import { EMPTY_USAGE } from "@/storage/usage";
import { Composer, Messages } from "@/ui/Conversation";
import { money, number } from "@/ui/format";
import { Hint, Modal, ThreadMenu, Tip } from "@/ui/primitives";
import { RequestLog, SettingsView } from "@/ui/Settings";
import { Sidebar } from "@/ui/Sidebar";
import { UpdateBar } from "@/ui/UpdateBar";
import type { ImageView, PendingAttachment, RequestRow, ThreadView } from "@/ui/types";
import { useAttachments, useFileUrls } from "./useAttachments";
import { useKeys } from "./useKeys";
import { useTheme } from "./useTheme";
import { useUpdate } from "./useUpdate";
import {
  messageViews,
  modelOption,
  requestRow,
  threadTokens,
  threadView,
  withLive,
  type LiveAnswer,
} from "./viewModels";

export interface ChatAppProps {
  db: SqlDb;
  tenant: Tenant;
  catalog: Catalog;
  keysApi: KeysApi;
  adapterFor: (provider: ProviderId) => ProviderAdapter;
  files: FilesApi;
  prepareImage: (file: File) => Promise<PreparedImage>;
  updates: UpdateApi;
}

const MODEL_KEY = "fuse.model";
const LAST_THREAD_KEY = "fuse.lastThread";

function readLastThread(): string | null {
  try {
    return localStorage.getItem(LAST_THREAD_KEY);
  } catch {
    return null;
  }
}
const DEFAULT_MODEL = { provider: "anthropic", id: "claude-sonnet-5-5" } as const;

function initialModel(catalog: Catalog): CatalogModel {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(MODEL_KEY);
  } catch {
    // no remembered model
  }
  const [provider, id] = saved?.split("/") ?? [];
  const remembered =
    (provider === "openai" || provider === "anthropic") && id
      ? findModel(catalog, provider, id)
      : undefined;
  const fallback = catalog.models[0];
  if (!fallback) throw new Error("The model catalog is empty");
  return remembered ?? findModel(catalog, DEFAULT_MODEL.provider, DEFAULT_MODEL.id) ?? fallback;
}

const lastModelOf = (messages: Message[], catalog: Catalog) => {
  const m = messages.findLast((x) => x.role === "assistant" && x.model);
  const provider = m?.provider;
  return m?.model && (provider === "openai" || provider === "anthropic")
    ? findModel(catalog, provider, m.model)
    : undefined;
};

export function ChatApp({
  db,
  tenant,
  catalog,
  keysApi,
  adapterFor,
  files,
  prepareImage,
  updates,
}: ChatAppProps) {
  const appUpdate = useUpdate(updates);
  // `at` is when the list was loaded: sidebar date groups are relative to it.
  const [{ threads, at }, setThreadList] = useState<{ threads: Thread[]; at: number }>({
    threads: [],
    at: 0,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Read once at startup: the thread to reopen.
  const [lastThread] = useState(readLastThread);
  const [messages, setMessages] = useState<Message[]>([]);
  // Files attached to the messages on screen, by message id.
  const [threadFiles, setThreadFiles] = useState<Map<string, FileRecord[]>>(new Map());
  // Web sources cited by the answers on screen, by message id.
  const [threadSources, setThreadSources] = useState<Map<string, Citation[]>>(new Map());
  // The search toggle for a chat that hasn't been saved yet.
  const [draftSearch, setDraftSearch] = useState(false);
  const [live, setLive] = useState<Record<string, LiveAnswer>>({});
  const [model, setModel] = useState(() => initialModel(catalog));
  const [view, setView] = useState<"chat" | "settings">(
    import.meta.env.VITE_FUSE_VIEW === "settings" ? "settings" : "chat",
  );
  const [sidebar, setSidebar] = useState(() => window.innerWidth >= 800);
  const [picker, setPicker] = useState(false);
  const [deleting, setDeleting] = useState<ThreadView | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [log, setLog] = useState<RequestRow[] | null>(null);
  const [theme, setTheme] = useTheme();
  const controllers = useRef(new Map<string, AbortController>());
  const selectedRef = useRef(selectedId);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  // Every provider call gets a request_log row, key tests included (0 tokens, $0).
  const logKeyTest = useCallback(
    (provider: ProviderId, r: KeyTestResult) => {
      void logRequest(db, tenant, {
        threadId: null,
        messageId: null,
        purpose: "key_test",
        provider,
        model: "models.list",
        attempt: 1,
        usage: { ...EMPTY_USAGE, latencyMs: r.latencyMs },
        httpStatus: r.httpStatus,
        errorCode: r.status === "ok" ? null : r.status,
        errorMessage: null,
        providerRequestId: r.requestId,
      });
    },
    [db, tenant],
  );
  const keys = useKeys(keysApi, logKeyTest);

  const deps: ChatDeps = useMemo(
    () => ({ db, tenant, catalog, adapterFor, files }),
    [db, tenant, catalog, adapterFor, files],
  );
  const attachments = useAttachments({ db, tenant, files, prepareImage });

  const report = (e: unknown) => {
    setProblem(e instanceof Error ? e.message : String(e));
  };
  const refreshThreads = useCallback(async () => {
    const list = await listThreads(db, tenant);
    setThreadList({ threads: list, at: Date.now() });
  }, [db, tenant]);
  /** A thread's messages and their attached files. */
  const loadThread = useCallback(
    async (threadId: string) => {
      const rows = await listMessages(db, tenant, threadId);
      const attached = await filesForMessages(
        db,
        tenant,
        rows.filter((m) => m.role === "user").map((m) => m.id),
      );
      const cited = await citationsForMessages(
        db,
        tenant,
        rows.filter((m) => m.role === "assistant").map((m) => m.id),
      );
      return { rows, attached, cited };
    },
    [db, tenant],
  );
  /** Reloads a thread's messages if it's still the one on screen. */
  const reload = useCallback(
    async (threadId: string) => {
      const { rows, attached, cited } = await loadThread(threadId);
      if (selectedRef.current === threadId) {
        setMessages(rows);
        setThreadFiles(attached);
        setThreadSources(cited);
      }
      return rows;
    },
    [loadThread],
  );

  useEffect(() => {
    listThreads(db, tenant)
      .then(async (list) => {
        setThreadList({ threads: list, at: Date.now() });
        // Reopen on the thread that was open last time, if it still exists.
        if (!lastThread || !list.some((t) => t.id === lastThread)) return;
        const { rows, attached, cited } = await loadThread(lastThread);
        if (selectedRef.current !== null) return; // the user already moved on
        setSelectedId(lastThread);
        selectedRef.current = lastThread;
        setMessages(rows);
        setThreadFiles(attached);
        setThreadSources(cited);
        const last = lastModelOf(rows, catalog);
        if (last) setModel(last);
      })
      .catch(report);
  }, [db, tenant, catalog, lastThread, loadThread]);
  useEffect(() => {
    if (selectedId === null) return;
    try {
      localStorage.setItem(LAST_THREAD_KEY, selectedId);
    } catch {
      // not remembered
    }
  }, [selectedId]);

  const chooseModel = (next: CatalogModel) => {
    setModel(next);
    try {
      localStorage.setItem(MODEL_KEY, `${next.provider}/${next.id}`);
    } catch {
      // not remembered
    }
  };

  const select = (id: string) => {
    setSelectedId(id);
    selectedRef.current = id;
    setView("chat");
    setMessages([]);
    setThreadFiles(new Map());
    setThreadSources(new Map());
    attachments.clear();
    reload(id).then((rows) => {
      // Continue on the model this thread last used.
      const last = live[id]?.model ?? lastModelOf(rows, catalog);
      if (last) setModel(last);
    }, report);
  };

  const clearAttachments = attachments.clear;
  const newChat = useCallback(() => {
    setSelectedId(null);
    selectedRef.current = null;
    setMessages([]);
    setThreadFiles(new Map());
    setThreadSources(new Map());
    setDraftSearch(false);
    clearAttachments();
    setView("chat");
  }, [clearAttachments]);

  /** Streams one answer (a new question, or a retry of the last one) into a thread. */
  const stream = async (
    threadId: string,
    userText: string | null,
    sent: FileRecord[] = [],
    webSearch = false,
  ) => {
    const controller = new AbortController();
    controllers.current.set(threadId, controller);
    setLive((all) => ({
      ...all,
      [threadId]: { threadId, model, text: "", userText, files: sent },
    }));
    let loaded = false;
    const onText = (text: string) => {
      setLive((all) => {
        const current = all[threadId];
        return current ? { ...all, [threadId]: { ...current, text } } : all;
      });
      if (!loaded) {
        // The engine has saved the question and the answer's placeholder by now.
        loaded = true;
        void reload(threadId);
        void refreshThreads(); // shows the new thread's title right away
      }
    };
    const patchLive = (change: Partial<LiveAnswer>) => {
      setLive((all) => {
        const current = all[threadId];
        return current ? { ...all, [threadId]: { ...current, ...change } } : all;
      });
    };
    const input = {
      threadId,
      model,
      signal: controller.signal,
      onText,
      webSearch,
      onStatus: (status: "searching" | null) => {
        patchLive({ searching: status === "searching" });
      },
      onCitations: (sources: Citation[]) => {
        patchLive({ sources });
      },
    };
    try {
      await (userText === null
        ? retryLast(deps, input)
        : sendMessage(deps, { ...input, text: userText, fileIds: sent.map((f) => f.id) }));
    } catch (e) {
      report(e);
    } finally {
      controllers.current.delete(threadId);
      await reload(threadId).catch(report);
      setLive((all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== threadId)));
      await refreshThreads().catch(report);
    }
  };

  const send = async (text: string) => {
    const sent = attachments.take();
    try {
      let threadId = selectedId;
      const search = searchOn;
      if (threadId === null) {
        const thread = await createThread(db, tenant);
        threadId = thread.id;
        if (search) await setThreadWebSearch(db, tenant, threadId, true);
        setSelectedId(threadId);
        selectedRef.current = threadId;
        await refreshThreads();
      }
      await stream(threadId, text, sent, search);
    } catch (e) {
      report(e);
    }
  };
  const retry = () => {
    if (selectedId && !live[selectedId]) void stream(selectedId, null, [], searchOn);
  };
  const stop = useCallback(() => {
    if (selectedRef.current) controllers.current.get(selectedRef.current)?.abort();
  }, []);

  const thread = threads.find((t) => t.id === selectedId);
  const searchOn = thread ? thread.webSearch : draftSearch;
  const toggleSearch = () => {
    if (!thread) {
      setDraftSearch((on) => !on);
      return;
    }
    setThreadWebSearch(db, tenant, thread.id, !thread.webSearch).then(refreshThreads).catch(report);
  };
  const liveHere = selectedId ? live[selectedId] : undefined;
  const wantedFiles = useMemo(
    () => [...[...threadFiles.values()].flat(), ...(liveHere?.files ?? [])],
    [threadFiles, liveHere],
  );
  const fileUrls = useFileUrls(files, wantedFiles);
  const shown = useMemo(() => {
    const images = new Map<string, ImageView[]>();
    const view = (f: FileRecord): ImageView => ({
      id: f.id,
      name: f.name,
      kind: f.mime.startsWith("image/") ? "image" : "document",
      url: fileUrls[f.sha256] ?? null,
    });
    for (const [id, list] of threadFiles) images.set(id, list.map(view));
    if (liveHere?.files.length) images.set("live-question", liveHere.files.map(view));
    const views = messageViews(withLive(messages, liveHere), catalog, images, threadSources);
    // The answer streaming now shows its live search status and sources.
    const streamingAnswer = views.findLast((v) => v.status === "streaming");
    if (liveHere && streamingAnswer) {
      if (liveHere.searching) streamingAnswer.searching = true;
      if (liveHere.sources?.length) streamingAnswer.sources = liveHere.sources;
    }
    return views;
  }, [messages, liveHere, threadFiles, threadSources, fileUrls, catalog]);
  const streaming = selectedId !== null && selectedId in live;
  const keyFor = keys.keys.find((k) => k.provider === model.provider);
  const missingKey = keyFor && !keyFor.saved && keyFor.busy !== "loading" ? keyFor.name : null;
  const threadViews = threads.map((t) => threadView(t, at));
  const options = catalog.models.map(modelOption);
  const pendingViews: PendingAttachment[] = attachments.pending.map((p) => {
    const isImage = p.file ? p.file.mime.startsWith("image/") : p.url !== undefined;
    const tokens = p.file
      ? isImage && p.file.width && p.file.height
        ? imageTokens(model.provider, p.file.width, p.file.height)
        : (p.file.tokenEstimate ?? 0)
      : 0;
    const micro = Math.round((tokens * priceToMicro(model.price.input)) / 1_000_000);
    const pages = p.pages ? `${number(p.pages)} page${p.pages === 1 ? "" : "s"} · ` : "";
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      kind: isImage ? "image" : "document",
      ...(p.url ? { url: p.url } : {}),
      ...(p.error ? { error: p.error } : {}),
      ...(tokens ? { detail: `${pages}~${number(tokens)} tokens · ${money(micro)} per turn` } : {}),
      ...(!isImage && tokens > LARGE_TEXT_TOKENS ? { large: true } : {}),
    };
  });
  const sendingImages = attachments.pending.some(
    (p) => p.status !== "error" && (p.file?.mime.startsWith("image/") ?? p.url !== undefined),
  );
  const blocked =
    sendingImages && !model.capabilities.includes("vision")
      ? `${model.displayName} can't read images. Pick another model (Ctrl+K).`
      : null;

  const showRename = () => {
    if (!thread) return;
    setName(thread.title);
    setRenaming(true);
  };
  const rename = (id: string, title: string) => {
    renameThread(db, tenant, id, title).then(refreshThreads).catch(report);
  };

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        if (key === "b") {
          event.preventDefault();
          setSidebar((open) => !open);
        } else if (key === "n") {
          event.preventDefault();
          newChat();
        } else if (key === "k") {
          event.preventDefault();
          setView("chat");
          setPicker((open) => !open);
        } else if (event.key === ",") {
          event.preventDefault();
          setView((current) => (current === "chat" ? "settings" : "chat"));
        } else if (key === "r" && shown.at(-1)?.status === "error") {
          event.preventDefault();
          retry();
        }
      }
      if (event.key === "Escape" && !picker && !deleting && !renaming && !log) stop();
    };
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("keydown", keyboard);
    };
  });

  return (
    <Tooltip.Provider>
      <div className="flex h-dvh min-h-[480px] min-w-[640px] flex-col overflow-hidden bg-background text-foreground">
        <UpdateBar
          update={appUpdate.update}
          onRestart={appUpdate.restart}
          onDismiss={appUpdate.dismiss}
        />
        {problem && (
          <div
            role="alert"
            className="flex items-center gap-2 border-b border-destructive/25 bg-destructive/5 px-4 py-2 text-xs"
          >
            <CircleAlert className="size-3.5 text-destructive" />
            <span className="flex-1">{problem}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss"
              onClick={() => {
                setProblem(null);
              }}
            >
              <X />
            </Button>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          {sidebar && (
            <Sidebar
              threads={threadViews}
              selectedId={selectedId}
              onSelect={select}
              onNew={newChat}
              onCollapse={() => {
                setSidebar(false);
              }}
              onSettings={() => {
                setView("settings");
              }}
              onRename={rename}
              onDelete={setDeleting}
            />
          )}
          {view === "settings" ? (
            <SettingsView
              keys={keys.keys}
              version={appUpdate.version}
              theme={theme}
              onTheme={setTheme}
              onBack={() => {
                setView("chat");
              }}
              onSaveKey={keys.save}
              onTestKey={keys.test}
              onDeleteKey={keys.remove}
              onShowLog={() => {
                listRecentRequests(db, tenant, 100).then((rows) => {
                  const now = Date.now();
                  setLog(rows.map((r) => requestRow(r, catalog, now)));
                }, report);
              }}
            />
          ) : (
            <main className="flex min-w-0 flex-1 flex-col">
              <header className="flex h-[66px] shrink-0 items-center gap-3 border-b px-7 max-[800px]:px-5">
                {!sidebar && (
                  <Tip label="Show sidebar · Ctrl+B">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Show sidebar (Ctrl+B)"
                      onClick={() => {
                        setSidebar(true);
                      }}
                    >
                      <PanelLeft />
                    </Button>
                  </Tip>
                )}
                <div className="min-w-0 flex-1">
                  <button
                    className="group flex max-w-full items-center gap-2 text-left"
                    onClick={showRename}
                    disabled={!thread}
                  >
                    <h1 className="truncate text-[13px] font-semibold tracking-tight">
                      {thread?.title ?? "New chat"}
                    </h1>
                    {thread && (
                      <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                    )}
                  </button>
                </div>
                {thread && (
                  <>
                    <Tip label="Total cost and tokens for this conversation">
                      <div
                        tabIndex={0}
                        aria-label="Thread total"
                        className="flex items-center gap-2 rounded-md px-1 py-1 font-mono text-[10px] text-muted-foreground"
                      >
                        <span className="text-foreground/80">{money(thread.costMicroUsd)}</span>
                        <span className="text-border">/</span>
                        <span>{number(threadTokens(messages))} tokens</span>
                      </div>
                    </Tip>
                    <ThreadMenu
                      onRename={showRename}
                      onDelete={() => {
                        setDeleting(threadView(thread, at));
                      }}
                    />
                  </>
                )}
              </header>
              <Messages
                key={selectedId ?? "new"}
                messages={shown}
                modelName={model.displayName}
                startedAt={messages[0]?.createdAt ?? null}
                onRetry={retry}
              />
              <Composer
                key={`composer-${selectedId ?? "new"}`}
                model={modelOption(model)}
                models={options}
                streaming={streaming}
                missingKey={missingKey}
                pickerOpen={picker}
                onPickerOpen={setPicker}
                onSelectModel={(o) => {
                  const next = findModel(catalog, o.provider, o.id);
                  if (next) chooseModel(next);
                }}
                onSend={(text) => void send(text)}
                onStop={stop}
                onSettings={() => {
                  setView("settings");
                }}
                attachments={pendingViews}
                blocked={blocked}
                onAddFiles={attachments.add}
                onRemoveAttachment={attachments.remove}
                webSearch={model.capabilities.includes("web_search") ? searchOn : null}
                onToggleWebSearch={toggleSearch}
              />
            </main>
          )}
        </div>
        <Modal
          open={Boolean(deleting)}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          title="Delete this conversation?"
          description={`“${deleting?.title ?? ""}” and its messages will be removed.`}
        >
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setDeleting(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const id = deleting?.id;
                setDeleting(null);
                if (!id) return;
                controllers.current.get(id)?.abort();
                if (selectedId === id) newChat();
                deleteThread(db, tenant, id).then(refreshThreads).catch(report);
              }}
            >
              Delete conversation
            </Button>
          </div>
        </Modal>
        <Modal
          open={renaming}
          onOpenChange={setRenaming}
          title="Rename conversation"
          description="Give this conversation a name that’s easy to find."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (thread && name.trim()) {
                rename(thread.id, name.trim());
                setRenaming(false);
              }
            }}
          >
            <Input
              aria-label="Conversation title"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
            <div className="mt-5 flex justify-end">
              <Button type="submit" disabled={!name.trim()}>
                Save name<Hint>Enter</Hint>
              </Button>
            </div>
          </form>
        </Modal>
        <Modal
          open={log !== null}
          onOpenChange={(open) => {
            if (!open) setLog(null);
          }}
          title="Request log"
          description="The last 100 provider calls, newest first. No keys or message text are stored here."
          wide
        >
          <RequestLog rows={log ?? []} />
        </Modal>
      </div>
    </Tooltip.Provider>
  );
}
