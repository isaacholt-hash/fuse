// The chat screen: Astra's presentational components (src/ui) wired to storage, keys and the chat
// engine. All state that matters lives in SQLite; this holds only what's on screen.
import { CircleAlert, EyeOff, Folder, PanelLeft, Pencil, X } from "lucide-react";
import { Tooltip } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { findModel, type Catalog, type ProviderId } from "@/catalog/catalog";
import { priceToMicro } from "@/cost/cost";
import type { FilesApi } from "@/files/api";
import { LARGE_TEXT_TOKENS } from "@/files/documents";
import { imageTokens, type PreparedImage } from "@/files/images";
import {
  effectiveInstructions,
  instructionTokens,
  MAX_INSTRUCTION_CHARS,
} from "@/chat/instructions";
import {
  editQuestion,
  escalateLast,
  regenerate,
  retryLast,
  sendMessage,
  type ChatDeps,
} from "@/chat/sendMessage";
import { housekeepingModel } from "@/chat/housekeeping";
import { classify } from "@/routing/classify";
import {
  chooseTier,
  tierModels,
  tierOf,
  TIER_ORDER,
  type RoutingPolicy,
  type TierId,
} from "@/routing/policy";
import { AUTO, modeOf, route, type RouteMode } from "@/routing/route";
import { autoTitle, wantsAutoTitle } from "@/chat/title";
import { needsMemoryCheck, suggestMemories } from "@/memory/extract";
import { memoryTokens } from "@/memory/inject";
import { findSecret, SECRET_LABELS } from "@/memory/secrets";
import type { KeysApi, KeyTestResult } from "@/keys/api";
import type { ProviderAdapter } from "@/providers/types";
import type { Tenant } from "@/storage/defaults";
import { citationsForMessages, type Citation } from "@/storage/citations";
import { filesForMessages, type FileRecord } from "@/storage/files";
import {
  getGlobalInstructions,
  NO_INSTRUCTIONS,
  setGlobalInstructions,
  type GlobalInstructions,
} from "@/storage/instructions";
import {
  addMemory,
  approveProposal,
  deleteAllMemories,
  deleteMemory,
  editMemory,
  listMemories,
  listPendingProposals,
  memoriesForMessages,
  rejectProposal,
  type Memory,
  type Proposal,
} from "@/storage/memories";
import { listPath, setFeedback, type Message } from "@/storage/messages";
import { branchesOf, leafUnder, type BranchInfo } from "@/storage/tree";
import {
  createProject,
  deleteProject,
  listProjects,
  updateProject,
  type Project,
} from "@/storage/projects";
import { listRecentRequests, logRequest } from "@/storage/requestLog";
import {
  DEFAULT_MEMORY_SETTINGS,
  getMemorySettings,
  setMemorySettings,
  type MemorySettings,
} from "@/storage/settings";
import type { SqlDb } from "@/storage/sql";
import type { UpdateApi } from "@/update/api";
import {
  createThread,
  deleteThread,
  listThreads,
  renameThread,
  setThreadInstructions,
  purgeIncognito,
  purgeThread,
  setActiveLeaf,
  setThreadMemory,
  setThreadPins,
  setThreadProject,
  setThreadWebSearch,
  type Thread,
} from "@/storage/threads";
import { EMPTY_USAGE } from "@/storage/usage";
import { Composer, Messages } from "@/ui/Conversation";
import { money, number } from "@/ui/format";
import { Hint, Modal, ThreadMenu, Tip } from "@/ui/primitives";
import { RequestLog, SettingsView } from "@/ui/Settings";
import { GoldenSetSection } from "@/ui/GoldenSet";
import { parseGoldenSet, summarize, type GoldenPrompt } from "@/routing/golden";
import { scoreGoldenSet } from "@/routing/evaluate";
import { listGoldenPrompts, replaceGoldenPrompts } from "@/storage/goldenPrompts";
import {
  GlobalInstructionsSection,
  InstructionsButton,
  ThreadInstructionsDialog,
} from "@/ui/Instructions";
import { MemoryBar, MemoryReviewDialog, MemorySection } from "@/ui/Memory";
import { CATEGORY_LABELS } from "@/ui/memoryLabels";
import { ProjectDialog } from "@/ui/Projects";
import { SearchDialog, type SearchHitView } from "@/ui/Search";
import { Sidebar } from "@/ui/Sidebar";
import { searchChats } from "@/storage/search";
import { UpdateBar } from "@/ui/UpdateBar";
import type {
  ImageView,
  MemoryForm,
  MemoryView,
  PendingAttachment,
  ProposalView,
  ProjectForm,
  ProjectView,
  RequestRow,
  ThreadView,
} from "@/ui/types";
import { classifyInput } from "./routing";
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
  policy: RoutingPolicy;
  keysApi: KeysApi;
  adapterFor: (provider: ProviderId) => ProviderAdapter;
  files: FilesApi;
  prepareImage: (file: File) => Promise<PreparedImage>;
  updates: UpdateApi;
  recoveryKey: () => Promise<string>;
}

const LAST_THREAD_KEY = "fuse.lastThread";

function readLastThread(): string | null {
  try {
    return localStorage.getItem(LAST_THREAD_KEY);
  } catch {
    return null;
  }
}
/** An answer as a Markdown quote for the composer, trimmed to a readable length. */
const QUOTE_CHARS = 1_500;
const quoteOf = (text: string) => {
  const cut = text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS).trimEnd()}…` : text;
  return `${cut
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n\n`;
};

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
  policy,
  keysApi,
  adapterFor,
  files,
  prepareImage,
  updates,
  recoveryKey,
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
  // The path on screen (CH-04), every message in the thread, and where the path has siblings.
  const [messages, setMessages] = useState<Message[]>([]);
  const [threadAll, setThreadAll] = useState<Message[]>([]);
  const [threadBranches, setThreadBranches] = useState<Map<string, BranchInfo>>(new Map());
  // Files attached to the messages on screen, by message id.
  const [threadFiles, setThreadFiles] = useState<Map<string, FileRecord[]>>(new Map());
  // Web sources cited by the answers on screen, by message id.
  const [threadSources, setThreadSources] = useState<Map<string, Citation[]>>(new Map());
  // Memories sent with the answers on screen, by message id.
  const [threadMemories, setThreadMemories] = useState<Map<string, { text: string }[]>>(new Map());
  // Memory (step 7): saved facts, suggestions waiting, and what the last check skipped as secrets.
  const [memories, setMemories] = useState<Memory[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [golden, setGolden] = useState<GoldenPrompt[] | null>(null);
  const [memorySettings, setMemorySettingsState] =
    useState<MemorySettings>(DEFAULT_MEMORY_SETTINGS);
  const [skippedSecrets, setSkippedSecrets] = useState<string[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [checkingMemory, setCheckingMemory] = useState(false);
  // The search toggle for a chat that hasn't been saved yet: on by default, saved with the chat.
  const [draftSearch, setDraftSearch] = useState(true);
  // A new chat that will be incognito (CH-15): not kept, no memory.
  const [draftIncognito, setDraftIncognito] = useState(false);
  // Instructions for every chat (Settings), and for a chat that hasn't been saved yet.
  const [globalInstructions, setGlobal] = useState<GlobalInstructions | null>(null);
  const [draftInstructions, setDraftInstructions] = useState("");
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  // The project a new, unsaved chat will be created in.
  const [draftProject, setDraftProject] = useState<string | null>(null);
  // The project dialog: creating ("new"), editing (a project id), or closed.
  const [projectDialog, setProjectDialog] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, LiveAnswer>>({});
  // Search across chats (CH-02), and the message a result opened at.
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  // An answer quoted into the composer; `key` changes on every quote.
  const [quote, setQuote] = useState<{ text: string; key: number } | null>(null);
  // The composer's mode for a chat that hasn't been saved yet (RT-01); saved chats keep theirs.
  const [draftMode, setDraftMode] = useState<RouteMode>(AUTO);
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
  useEffect(() => {
    getGlobalInstructions(db, tenant).then(setGlobal, (e: unknown) => {
      setProblem(String(e));
    });
  }, [db, tenant]);
  const refreshProjects = useCallback(async () => {
    setProjects(await listProjects(db, tenant));
  }, [db, tenant]);
  useEffect(() => {
    listProjects(db, tenant).then(setProjects, (e: unknown) => {
      setProblem(String(e));
    });
  }, [db, tenant]);
  const refreshThreads = useCallback(async () => {
    const list = await listThreads(db, tenant);
    setThreadList({ threads: list, at: Date.now() });
  }, [db, tenant]);
  const refreshMemory = useCallback(async () => {
    setMemories(await listMemories(db, tenant));
    setProposals(await listPendingProposals(db, tenant));
  }, [db, tenant]);
  useEffect(() => {
    Promise.all([listMemories(db, tenant), listPendingProposals(db, tenant)]).then(
      ([saved, waiting]) => {
        setMemories(saved);
        setProposals(waiting);
      },
      report,
    );
    getMemorySettings(db, tenant).then(setMemorySettingsState, report);
    listGoldenPrompts(db, tenant).then((p) => {
      setGolden(p);
    }, report);
  }, [db, tenant]);
  /** Settings → Routing test set: a bad line refuses the whole file. */
  const importGolden = async (text: string): Promise<string[]> => {
    const parsed = parseGoldenSet(text);
    if (!parsed.ok) return parsed.errors;
    await replaceGoldenPrompts(db, tenant, parsed.prompts);
    setGolden(parsed.prompts);
    return [];
  };
  /** A thread's messages and their attached files. */
  const loadThread = useCallback(
    async (threadId: string) => {
      const { all, path: rows } = await listPath(db, tenant, threadId);
      const attached = await filesForMessages(
        db,
        tenant,
        rows.filter((m) => m.role === "user").map((m) => m.id),
      );
      const answers = rows.filter((m) => m.role === "assistant").map((m) => m.id);
      const cited = await citationsForMessages(db, tenant, answers);
      const used = await memoriesForMessages(db, tenant, answers);
      return { rows, all, attached, cited, used };
    },
    [db, tenant],
  );
  /** Reloads a thread's messages if it's still the one on screen. */
  const reload = useCallback(
    async (threadId: string) => {
      const { rows, all, attached, cited, used } = await loadThread(threadId);
      if (selectedRef.current === threadId) {
        setMessages(rows);
        setThreadAll(all);
        setThreadBranches(branchesOf(all, rows));
        setThreadFiles(attached);
        setThreadSources(cited);
        setThreadMemories(used);
      }
      return rows;
    },
    [loadThread],
  );

  useEffect(() => {
    // Incognito chats left by a crash or a forced close go before anything is listed.
    purgeIncognito(db, tenant)
      .then(() => listThreads(db, tenant))
      .then(async (list) => {
        setThreadList({ threads: list, at: Date.now() });
        // Reopen on the thread that was open last time, if it still exists.
        if (!lastThread || !list.some((t) => t.id === lastThread)) return;
        const { rows, all, attached, cited, used } = await loadThread(lastThread);
        if (selectedRef.current !== null) return; // the user already moved on
        setSelectedId(lastThread);
        selectedRef.current = lastThread;
        setMessages(rows);
        setThreadAll(all);
        setThreadBranches(branchesOf(all, rows));
        setThreadFiles(attached);
        setThreadSources(cited);
        setThreadMemories(used);
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

  const select = (id: string) => {
    setFocusId(null);
    setSelectedId(id);
    selectedRef.current = id;
    setView("chat");
    setMessages([]);
    setThreadAll([]);
    setThreadBranches(new Map());
    setThreadFiles(new Map());
    setThreadSources(new Map());
    setThreadMemories(new Map());
    attachments.clear();
    reload(id).catch(report);
  };

  const search = useCallback(
    async (text: string): Promise<SearchHitView[]> =>
      (await searchChats(db, tenant, text)).map((h) => ({
        key: h.messageId ?? `title-${h.threadId}`,
        threadId: h.threadId,
        threadTitle: h.threadTitle,
        messageId: h.messageId,
        kind: h.role === "user" ? "You" : h.role === "assistant" ? "Answer" : "Title",
        snippet: h.snippet,
        date: new Date(h.createdAt).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
      })),
    [db, tenant],
  );
  /** Opens a search result: its chat, on the branch that holds the message, scrolled to it. */
  const openHit = (hit: SearchHitView) => {
    setSearchOpen(false);
    void (async () => {
      if (hit.messageId) {
        const { all, path } = await listPath(db, tenant, hit.threadId);
        if (!path.some((m) => m.id === hit.messageId)) {
          await setActiveLeaf(db, tenant, hit.threadId, leafUnder(all, hit.messageId));
        }
      }
      select(hit.threadId);
      setFocusId(hit.messageId);
    })().catch(report);
  };

  const clearAttachments = attachments.clear;
  /** A new chat, optionally inside a project (starting on its default model, if it has one). */
  const newChat = useCallback(
    (projectId: string | null = null, incognito = false) => {
      setSelectedId(null);
      selectedRef.current = null;
      setMessages([]);
      setThreadAll([]);
      setThreadBranches(new Map());
      setThreadFiles(new Map());
      setThreadSources(new Map());
      setThreadMemories(new Map());
      setThreadMemories(new Map());
      setDraftSearch(true);
      setDraftIncognito(incognito);
      setDraftInstructions("");
      setDraftProject(projectId);
      // A project's default model pins new chats in it; otherwise they start on Auto.
      const preferred = projects.find((p) => p.id === projectId)?.defaultModel;
      setDraftMode(preferred ? { kind: "model", ...preferred } : AUTO);
      clearAttachments();
      setView("chat");
    },
    [clearAttachments, projects],
  );

  const savedProviders = keys.keys.filter((k) => k.saved).map((k) => k.provider);
  const openThread = threads.find((t) => t.id === selectedId);
  /** Auto, a pinned tier, or a pinned model (RT-01): saved per chat. */
  const mode: RouteMode = openThread ? modeOf(openThread) : draftMode;
  /** The chat keeps to its provider on a price tie (RT-06). */
  const stayOn = lastModelOf(messages, catalog)?.provider;
  /**
   * The model the composer shows and estimates with: the pinned one, or the cheapest at the
   * pinned tier (Auto: the quality floor). With no usable key, the tier's first model, so the
   * composer can say which key is missing.
   */
  const model = (() => {
    if (mode.kind === "model") {
      const pinned = findModel(catalog, mode.provider, mode.id);
      if (pinned) return pinned;
    }
    const tier = mode.kind === "tier" ? mode.tier : policy.floor.default;
    const pick = (providers: readonly ProviderId[]) =>
      tierModels(policy, catalog, tier, { providers, ...(stayOn ? { prefer: stayOn } : {}) })[0];
    const fallback = catalog.models[0];
    if (!fallback) throw new Error("The model catalog is empty");
    return pick(savedProviders) ?? pick(["anthropic", "openai"]) ?? fallback;
  })();
  const chooseMode = (next: RouteMode) => {
    if (!openThread) {
      setDraftMode(next);
      return;
    }
    setThreadPins(db, tenant, openThread.id, {
      tier: next.kind === "tier" ? next.tier : null,
      model: next.kind === "model" ? { provider: next.provider, id: next.id } : null,
    })
      .then(refreshThreads)
      .catch(report);
  };
  /** The model for one question under the current mode; null (with a message) if none can take it. */
  const routeFor = (text: string, files: FileRecord[], history: Message[], webSearch: boolean) => {
    const task = classify(classifyInput(text, files, history, webSearch));
    const routed = route(policy, catalog, mode, task, {
      providers: savedProviders,
      ...(stayOn ? { prefer: stayOn } : {}),
    });
    if (!routed.ok) {
      setProblem(routed.error);
      return null;
    }
    return routed;
  };
  /** The tier Auto would pick for the draft, shown on the mode button as you type. */
  const previewTier = (text: string) => {
    if (mode.kind !== "auto" || !text.trim()) return null;
    const ready = attachments.pending.flatMap((p) => (p.file ? [p.file] : []));
    const task = classify(classifyInput(text, ready, messages, searchOn));
    const tier = chooseTier(policy, task).tier;
    return policy.tiers.find((t) => t.id === tier)?.label ?? tier;
  };

  /** After a chat's first answer, the housekeeping model gives it a real title (CH-09). */
  const nameThread = (threadId: string, rows: Message[]) => {
    const current = threads.find((t) => t.id === threadId);
    if (current?.incognito) return; // nothing about an incognito chat is kept, its title included
    if (!wantsAutoTitle(current?.titleSource ?? "auto", rows)) return;
    const helper = housekeepingModel(policy, catalog, "title", savedProviders, model.provider);
    if (!helper) return;
    autoTitle(deps, catalog, threadId, helper)
      .then(async (r) => {
        if (r.title) await refreshThreads();
      })
      .catch(report);
  };

  /**
   * What an answer is for: a new question, a retry of the last one, a stronger re-run of the
   * latest answer, a fresh answer to any question, or an edited question (CH-04).
   */
  type Job =
    | { kind: "send"; text: string; files: FileRecord[] }
    | { kind: "retry"; questionId: string }
    | { kind: "escalate"; answerId: string }
    | { kind: "regenerate"; answerId: string; questionId: string }
    | { kind: "edit"; messageId: string; parentId: string | null; text: string };

  /** Streams one answer into a thread. */
  const stream = async (
    threadId: string,
    routed: NonNullable<ReturnType<typeof routeFor>>,
    job: Job,
    webSearch = false,
  ) => {
    const controller = new AbortController();
    controllers.current.set(threadId, controller);
    // Where the live answer goes on screen until the saved rows load (see withLive).
    const placement =
      job.kind === "send"
        ? { userText: job.text, files: job.files }
        : job.kind === "edit"
          ? { userText: job.text, files: [], after: job.parentId }
          : {
              userText: null,
              files: [],
              after: job.kind === "escalate" ? job.answerId : job.questionId,
            };
    setLive((all) => ({
      ...all,
      [threadId]: { threadId, model: routed.model, text: "", ...placement },
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
      model: routed.model,
      route: routed.info,
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
      await (job.kind === "send"
        ? sendMessage(deps, { ...input, text: job.text, fileIds: job.files.map((f) => f.id) })
        : job.kind === "retry"
          ? retryLast(deps, input)
          : job.kind === "escalate"
            ? escalateLast(deps, input)
            : job.kind === "regenerate"
              ? regenerate(deps, { ...input, answerId: job.answerId })
              : editQuestion(deps, { ...input, messageId: job.messageId, text: job.text }));
    } catch (e) {
      report(e);
    } finally {
      controllers.current.delete(threadId);
      const rows = await reload(threadId).catch(report);
      if (rows) nameThread(threadId, rows);
      setLive((all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== threadId)));
      await refreshThreads().catch(report);
    }
  };

  const send = async (text: string) => {
    const ready = attachments.pending.flatMap((p) =>
      p.status === "ready" && p.file ? [p.file] : [],
    );
    const search = searchOn;
    const routed = routeFor(text, ready, messages, search);
    if (!routed) return;
    const sent = attachments.take();
    try {
      let threadId = selectedId;
      if (threadId === null) {
        const thread = await createThread(db, tenant, undefined, draftProject, draftIncognito);
        threadId = thread.id;
        if (search) await setThreadWebSearch(db, tenant, threadId, true);
        if (draftInstructions) {
          await setThreadInstructions(db, tenant, threadId, draftInstructions);
        }
        if (draftMode.kind !== "auto") {
          await setThreadPins(db, tenant, threadId, {
            tier: draftMode.kind === "tier" ? draftMode.tier : null,
            model:
              draftMode.kind === "model"
                ? { provider: draftMode.provider, id: draftMode.id }
                : null,
          });
        }
        setSelectedId(threadId);
        selectedRef.current = threadId;
        await refreshThreads();
      }
      await stream(threadId, routed, { kind: "send", text, files: sent }, search);
    } catch (e) {
      report(e);
    }
  };
  /** Routes the question at `index` on the path, with what came before it as history. */
  const routeQuestion = (question: Message, text = question.content) =>
    routeFor(
      text,
      threadFiles.get(question.id) ?? [],
      messages.slice(0, messages.indexOf(question)),
      searchOn,
    );
  const retry = () => {
    if (!selectedId || live[selectedId]) return;
    const question = messages.findLast((m) => m.role === "user");
    const routed = question && routeQuestion(question);
    if (question && routed) {
      void stream(selectedId, routed, { kind: "retry", questionId: question.id }, searchOn);
    }
  };
  /** A fresh answer to any question (CH-04); the old one stays on its own branch. */
  const regenerateAnswer = (answerId: string) => {
    if (!selectedId || live[selectedId]) return;
    const answer = messages.find((m) => m.id === answerId);
    const question = answer && messages.find((m) => m.id === answer.parentId);
    const routed = question && routeQuestion(question);
    if (!question || !routed) return;
    void stream(
      selectedId,
      routed,
      { kind: "regenerate", answerId, questionId: question.id },
      searchOn,
    );
  };
  /** Sends an edited question as a new branch (CH-04). */
  const editAndSend = (messageId: string, text: string) => {
    if (!selectedId || live[selectedId]) return;
    const question = messages.find((m) => m.id === messageId);
    const routed = question && routeQuestion(question, text);
    if (!question || !routed) return;
    void stream(
      selectedId,
      routed,
      { kind: "edit", messageId, parentId: question.parentId, text },
      searchOn,
    );
  };
  /** Shows another branch: the newest path through the chosen sibling. */
  const switchBranch = (messageId: string, step: -1 | 1) => {
    const threadId = selectedId;
    const info = threadBranches.get(messageId);
    if (!threadId || !info || live[threadId]) return;
    const target = info.siblings[info.position - 1 + step];
    if (!target) return;
    setActiveLeaf(db, tenant, threadId, leafUnder(threadAll, target))
      .then(() => reload(threadId))
      .catch(report);
  };
  const tierLabel = (tier: TierId) => policy.tiers.find((t) => t.id === tier)?.label ?? tier;
  /** The tier the latest answer came from, and the one above it; null when it's already on Best. */
  const escalation = (answer: Message | undefined) => {
    if (!answer || (answer.status !== "complete" && answer.status !== "stopped")) return null;
    const provider = answer.provider;
    const used =
      answer.model && (provider === "openai" || provider === "anthropic")
        ? findModel(catalog, provider, answer.model)
        : undefined;
    const from = answer.route?.tier ?? (used && tierOf(policy, used)) ?? "balanced";
    const to = TIER_ORDER[TIER_ORDER.indexOf(from) + 1];
    return to && to !== "cheap" ? { from, to } : null;
  };
  /** "Try a stronger model" (RT-04): the last question again, one tier up; the old answer stays. */
  const escalate = () => {
    if (!selectedId || live[selectedId]) return;
    const answer = messages.findLast((m) => m.role === "assistant");
    const question = messages.findLast((m) => m.role === "user");
    const step = escalation(answer);
    if (!answer || !question || !step) return;
    const before = messages.slice(0, messages.indexOf(question));
    const task = classify(
      classifyInput(question.content, threadFiles.get(question.id) ?? [], before, searchOn),
    );
    const routed = route(policy, catalog, { kind: "tier", tier: step.to }, task, {
      providers: savedProviders,
      ...(stayOn ? { prefer: stayOn } : {}),
    });
    if (!routed.ok) {
      setProblem(routed.error);
      return;
    }
    const info = {
      ...routed.info,
      ruleId: "escalation",
      reason: `One tier up from ${tierLabel(step.from)}, at your request`,
    };
    void stream(
      selectedId,
      { ...routed, info },
      { kind: "escalate", answerId: answer.id },
      searchOn,
    );
  };
  const stop = useCallback(() => {
    if (selectedRef.current) controllers.current.get(selectedRef.current)?.abort();
  }, []);

  /**
   * Asks the housekeeping model what to remember from a chat (PM-03). Runs by itself when you
   * leave a chat with new messages (if suggestions are on), or when asked from the chat's menu.
   */
  const checkMemory = async (threadId: string, asked: boolean) => {
    const target = threads.find((t) => t.id === threadId);
    if (!target || target.incognito || threadId in live) return;
    if (!asked && (!memorySettings.suggest || !needsMemoryCheck(target))) return;
    const last = threadId === selectedId ? lastModelOf(messages, catalog) : undefined;
    const helper = housekeepingModel(
      policy,
      catalog,
      "memory",
      savedProviders,
      last?.provider ?? model.provider,
    );
    if (!helper) {
      if (asked) setProblem("Add an API key in Settings to get memory suggestions.");
      return;
    }
    setCheckingMemory(true);
    try {
      const r = await suggestMemories(deps, catalog, threadId, helper);
      setSkippedSecrets(r.skipped.map((k) => SECRET_LABELS[k]));
      if (r.error && asked) setProblem(`Memory suggestions failed: ${r.error}`);
      if (asked && !r.error && r.proposed === 0 && r.skipped.length === 0) {
        setProblem("Nothing new to remember from this chat.");
      }
      if (asked && r.proposed > 0) setReviewOpen(true);
      await refreshMemory();
      await refreshThreads();
    } finally {
      setCheckingMemory(false);
    }
  };
  const checkMemoryRef = useRef(checkMemory);
  const threadsRef = useRef(threads);
  useEffect(() => {
    checkMemoryRef.current = checkMemory;
    threadsRef.current = threads;
  });
  // Leaving a chat (opening another, or a new one) is the "end of a thread" for memory.
  const previousSelected = useRef<string | null>(null);
  useEffect(() => {
    const left = previousSelected.current;
    previousSelected.current = selectedId;
    if (!left || left === selectedId) return;
    if (threadsRef.current.find((t) => t.id === left)?.incognito) {
      // Leaving an incognito chat deletes it (CH-15).
      purgeThread(db, tenant, left).then(refreshThreads).catch(report);
      return;
    }
    checkMemoryRef.current(left, false).catch(report);
  }, [selectedId, db, tenant, refreshThreads]);

  const memoryProblem = (form: MemoryForm) => {
    const secret = findSecret(form.text);
    return secret ? `That looks like ${SECRET_LABELS[secret]}. Memory never stores those.` : null;
  };
  const addOwnMemory = (form: MemoryForm) => {
    const problem = memoryProblem(form);
    if (problem) return problem;
    addMemory(db, tenant, form).then(refreshMemory).catch(report);
    return null;
  };
  const editOwnMemory = (id: string, form: MemoryForm) => {
    const problem = memoryProblem(form);
    if (problem) return problem;
    editMemory(db, tenant, id, form).then(refreshMemory).catch(report);
    return null;
  };
  const keepProposal = (id: string, text?: string) => {
    const p = proposals.find((x) => x.id === id);
    if (p && p.op !== "delete" && text !== undefined) {
      const secret = findSecret(text);
      if (secret) {
        setProblem(`That looks like ${SECRET_LABELS[secret]}. Memory never stores those.`);
        return;
      }
    }
    approveProposal(db, tenant, id, text).then(refreshMemory).catch(report);
  };
  const keepAllProposals = () => {
    void (async () => {
      for (const p of proposals) await approveProposal(db, tenant, p.id);
      await refreshMemory();
      setReviewOpen(false);
    })().catch(report);
  };
  const skipAllProposals = () => {
    void (async () => {
      for (const p of proposals) await rejectProposal(db, tenant, p.id);
      await refreshMemory();
      setReviewOpen(false);
    })().catch(report);
  };
  const saveMemorySettings = (value: MemorySettings) => {
    setMemorySettings(db, tenant, value)
      .then(() => getMemorySettings(db, tenant))
      .then(setMemorySettingsState)
      .catch(report);
  };
  const projectName = (id: string | null) =>
    id ? (projects.find((p) => p.id === id)?.name ?? null) : null;
  const shortDate = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const memoryViews: MemoryView[] = memories.map((m) => ({
    id: m.id,
    text: m.text,
    category: m.category,
    projectId: m.projectId,
    projectName: projectName(m.projectId),
    source: m.sourceThreadTitle,
    date: shortDate(m.createdAt),
    confidence: m.confidence,
  }));
  const proposalViews: ProposalView[] = proposals.map((p) => ({
    id: p.id,
    op: p.op,
    text: p.text,
    currentText: p.currentText,
    category: p.category,
    projectName: projectName(p.projectId),
    source: p.sourceThreadTitle,
    confidence: p.confidence,
  }));
  const copyMemories = () => {
    const text = (Object.keys(CATEGORY_LABELS) as Memory["category"][])
      .map((c) => {
        const list = memories.filter((m) => m.category === c);
        return list.length
          ? `${CATEGORY_LABELS[c]}\n${list.map((m) => `- ${m.text}`).join("\n")}`
          : "";
      })
      .filter(Boolean)
      .join("\n\n");
    navigator.clipboard.writeText(text).catch(report);
  };

  const thread = threads.find((t) => t.id === selectedId);
  const searchOn = thread ? thread.webSearch : draftSearch;
  const toggleSearch = () => {
    if (!thread) {
      setDraftSearch((on) => !on);
      return;
    }
    setThreadWebSearch(db, tenant, thread.id, !thread.webSearch).then(refreshThreads).catch(report);
  };
  const chatInstructions = thread ? thread.instructions : draftInstructions;
  const activeProjectId = thread ? thread.projectId : draftProject;
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const instructionParts = effectiveInstructions(
    globalInstructions ?? NO_INSTRUCTIONS,
    activeProject?.instructions ?? "",
    chatInstructions,
  );
  const moveThread = (projectId: string | null) => {
    if (!thread) return;
    setThreadProject(db, tenant, thread.id, projectId).then(refreshThreads).catch(report);
  };
  const editedProject = projects.find((p) => p.id === projectDialog);
  const saveProject = (form: ProjectForm) => {
    const editing = editedProject;
    setProjectDialog(null);
    void (async () => {
      if (editing) {
        await updateProject(db, tenant, editing.id, form);
      } else {
        const created = await createProject(db, tenant, form.name);
        await updateProject(db, tenant, created.id, form);
        await refreshProjects();
        // `projects` in newChat's closure doesn't have the new one yet: apply its model here.
        newChat(created.id);
        setDraftMode(form.defaultModel ? { kind: "model", ...form.defaultModel } : AUTO);
        return;
      }
      await refreshProjects();
    })().catch(report);
  };
  const removeProject = () => {
    const id = editedProject?.id;
    setProjectDialog(null);
    if (!id) return;
    if (draftProject === id) setDraftProject(null);
    deleteProject(db, tenant, id)
      .then(async () => {
        await refreshProjects();
        await refreshThreads();
      })
      .catch(report);
  };
  const saveChatInstructions = (text: string) => {
    if (!thread) {
      setDraftInstructions(text.trim());
      return;
    }
    setThreadInstructions(db, tenant, thread.id, text).then(refreshThreads).catch(report);
  };
  const saveGlobalInstructions = (value: GlobalInstructions) => {
    setGlobalInstructions(db, tenant, value)
      .then(() => getGlobalInstructions(db, tenant))
      .then(setGlobal)
      .catch(report);
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
    const views = messageViews(
      withLive(messages, liveHere),
      catalog,
      images,
      threadSources,
      threadMemories,
    );
    // The answer streaming now shows its live search status and sources.
    const streamingAnswer = views.findLast((v) => v.status === "streaming");
    if (liveHere && streamingAnswer) {
      if (liveHere.searching) streamingAnswer.searching = true;
      if (liveHere.sources?.length) streamingAnswer.sources = liveHere.sources;
    }
    for (const v of views) {
      const info = threadBranches.get(v.id);
      if (info) v.branch = { position: info.position, total: info.total };
    }
    return views;
  }, [
    messages,
    liveHere,
    threadFiles,
    threadSources,
    threadMemories,
    threadBranches,
    fileUrls,
    catalog,
  ]);
  // "Try a stronger model" goes on the latest answer only: earlier ones would need branching.
  const stronger = liveHere ? null : escalation(messages.findLast((m) => m.role === "assistant"));
  const latest = shown.at(-1);
  const withEscalation =
    stronger && latest?.role === "assistant"
      ? [...shown.slice(0, -1), { ...latest, escalateTo: tierLabel(stronger.to) }]
      : shown;
  const streaming = selectedId !== null && selectedId in live;
  const keyFor = keys.keys.find((k) => k.provider === model.provider);
  const missingKey = keyFor && !keyFor.saved && keyFor.busy !== "loading" ? keyFor.name : null;
  const threadViews = threads.filter((t) => !t.incognito).map((t) => threadView(t, at));
  const incognito = thread ? thread.incognito : draftIncognito;
  const projectViews: ProjectView[] = projects.map((p) => {
    const inside = threadViews.filter((t) => t.projectId === p.id);
    return {
      id: p.id,
      name: p.name,
      threads: inside,
      costMicro: inside.reduce((sum, t) => sum + t.costMicro, 0),
    };
  });
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
    sendingImages && mode.kind === "model" && !model.capabilities.includes("vision")
      ? `${model.displayName} can't read images. Pick another model (Ctrl+K).`
      : null;

  const tierDescription = (id: "balanced" | "best") =>
    policy.tiers.find((t) => t.id === id)?.description ?? "";
  const modeName =
    mode.kind === "auto"
      ? "Auto"
      : mode.kind === "tier"
        ? `${policy.tiers.find((t) => t.id === mode.tier)?.label ?? mode.tier} tier`
        : model.displayName;

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
          newChat(null, event.shiftKey);
        } else if (key === "f" && event.shiftKey) {
          event.preventDefault();
          setSearchOpen(true);
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
              projects={projectViews}
              selectedId={selectedId}
              activeProjectId={activeProjectId}
              onSelect={select}
              onNew={newChat}
              onNewProject={() => {
                setProjectDialog("new");
              }}
              onNewInProject={newChat}
              onEditProject={setProjectDialog}
              onCollapse={() => {
                setSidebar(false);
              }}
              onSettings={() => {
                setView("settings");
              }}
              onRename={rename}
              onDelete={setDeleting}
              onSearch={() => {
                setSearchOpen(true);
              }}
            />
          )}
          {view === "settings" ? (
            <SettingsView
              keys={keys.keys}
              version={appUpdate.version}
              onRecoveryKey={recoveryKey}
              instructions={
                globalInstructions && (
                  <GlobalInstructionsSection
                    value={globalInstructions}
                    maxChars={MAX_INSTRUCTION_CHARS}
                    onSave={saveGlobalInstructions}
                  />
                )
              }
              routing={
                golden && (
                  <GoldenSetSection
                    summary={summarize(golden)}
                    score={golden.length > 0 ? scoreGoldenSet(policy, golden) : null}
                    onImport={importGolden}
                  />
                )
              }
              memory={
                <MemorySection
                  key={memorySettings.budgetTokens}
                  memories={memoryViews}
                  projects={projects}
                  suggest={memorySettings.suggest}
                  budgetTokens={memorySettings.budgetTokens}
                  tokens={memories.reduce((sum, m) => sum + memoryTokens(m), 0)}
                  pendingCount={proposals.length}
                  onAdd={addOwnMemory}
                  onEdit={editOwnMemory}
                  onDelete={(id) => {
                    deleteMemory(db, tenant, id).then(refreshMemory).catch(report);
                  }}
                  onDeleteAll={() => {
                    deleteAllMemories(db, tenant).then(refreshMemory).catch(report);
                  }}
                  onSettings={saveMemorySettings}
                  onReview={() => {
                    setReviewOpen(true);
                  }}
                  onCopyAll={copyMemories}
                />
              }
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
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  {activeProject && (
                    <>
                      <button
                        className="flex max-w-[40%] shrink-0 items-center gap-1.5 rounded text-[12px] text-muted-foreground hover:text-foreground"
                        aria-label={`Project: ${activeProject.name}`}
                        onClick={() => {
                          setProjectDialog(activeProject.id);
                        }}
                      >
                        <Folder className="size-3.5 shrink-0" />
                        <span className="truncate">{activeProject.name}</span>
                      </button>
                      <span className="text-border">/</span>
                    </>
                  )}
                  <button
                    className="group flex min-w-0 items-center gap-2 text-left"
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
                {incognito ? (
                  <span
                    className="flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 text-[10px] text-muted-foreground"
                    aria-label="Incognito chat"
                  >
                    <EyeOff className="size-3" />
                    Incognito
                  </span>
                ) : (
                  !thread && (
                    <Tip label="Incognito: not saved, no memory · Ctrl+Shift+N">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Make this chat incognito"
                        onClick={() => {
                          setDraftIncognito(true);
                        }}
                      >
                        <EyeOff />
                      </Button>
                    </Tip>
                  )
                )}
                <InstructionsButton
                  count={instructionParts.length}
                  onClick={() => {
                    setInstructionsOpen(true);
                  }}
                />
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
                    {!thread.incognito && (
                      <ThreadMenu
                        projects={projects}
                        projectId={thread.projectId}
                        onMove={moveThread}
                        memoryOn={thread.memoryOn}
                        onToggleMemory={() => {
                          setThreadMemory(db, tenant, thread.id, !thread.memoryOn)
                            .then(refreshThreads)
                            .catch(report);
                        }}
                        onSuggestMemories={() => {
                          checkMemory(thread.id, true).catch(report);
                        }}
                        onRename={showRename}
                        onDelete={() => {
                          setDeleting(threadView(thread, at));
                        }}
                      />
                    )}
                  </>
                )}
              </header>
              <Messages
                key={selectedId ?? "new"}
                messages={withEscalation}
                modelName={modeName}
                startedAt={messages[0]?.createdAt ?? null}
                onRetry={retry}
                onEscalate={escalate}
                onRegenerate={regenerateAnswer}
                onEdit={editAndSend}
                onBranch={switchBranch}
                busy={streaming}
                focusId={focusId}
                onFeedback={(id, value) => {
                  const threadId = selectedId;
                  if (!threadId) return;
                  setFeedback(db, tenant, id, value)
                    .then(() => reload(threadId))
                    .catch(report);
                }}
                onQuote={(text) => {
                  setQuote((q) => ({ text: quoteOf(text), key: (q?.key ?? 0) + 1 }));
                }}
              />
              {incognito && (
                <p
                  role="note"
                  className="mx-auto mb-1 flex max-w-[716px] items-center gap-1.5 px-9 text-[10px] text-muted-foreground"
                >
                  <EyeOff className="size-3" />
                  Incognito: this chat isn&apos;t saved or searchable and doesn&apos;t use or add
                  memories. It&apos;s deleted when you leave it.
                </p>
              )}
              <MemoryBar
                count={proposals.length}
                checking={checkingMemory}
                skipped={skippedSecrets}
                onReview={() => {
                  setReviewOpen(true);
                }}
                onDismissSkipped={() => {
                  setSkippedSecrets([]);
                }}
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
                  chooseMode({ kind: "model", provider: o.provider, id: o.id });
                }}
                insert={quote}
                routing={{
                  selected: mode.kind === "auto" ? "auto" : mode.kind === "tier" ? mode.tier : null,
                  descriptions: {
                    auto: "Picks Balanced or Best for each message from what you ask",
                    balanced: tierDescription("balanced"),
                    best: tierDescription("best"),
                  },
                  preview: previewTier,
                  onSelect: (choice) => {
                    chooseMode(choice === "auto" ? AUTO : { kind: "tier", tier: choice });
                  },
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
        <SearchDialog
          open={searchOpen}
          onOpenChange={setSearchOpen}
          onSearch={search}
          onOpen={openHit}
        />
        <ProjectDialog
          key={projectDialog ?? "closed"}
          open={projectDialog !== null}
          onOpenChange={(open) => {
            if (!open) setProjectDialog(null);
          }}
          initial={
            editedProject
              ? {
                  name: editedProject.name,
                  instructions: editedProject.instructions,
                  defaultModel: editedProject.defaultModel,
                }
              : null
          }
          models={options}
          maxChars={MAX_INSTRUCTION_CHARS}
          onSave={saveProject}
          {...(editedProject ? { onDelete: removeProject } : {})}
        />
        <MemoryReviewDialog
          open={reviewOpen}
          onOpenChange={(open) => {
            setReviewOpen(open);
            if (!open) setSkippedSecrets([]);
          }}
          proposals={proposalViews}
          skipped={skippedSecrets}
          onKeep={keepProposal}
          onSkip={(id) => {
            rejectProposal(db, tenant, id).then(refreshMemory).catch(report);
          }}
          onKeepAll={keepAllProposals}
          onSkipAll={skipAllProposals}
        />
        <ThreadInstructionsDialog
          open={instructionsOpen}
          onOpenChange={setInstructionsOpen}
          globalParts={instructionParts.filter((p) => p.source !== "thread")}
          thread={chatInstructions}
          tokens={instructionTokens(instructionParts)}
          maxChars={MAX_INSTRUCTION_CHARS}
          onSave={saveChatInstructions}
          onEditGlobal={() => {
            setInstructionsOpen(false);
            setView("settings");
          }}
        />
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
