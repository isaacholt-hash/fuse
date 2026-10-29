// The chat screen: Astra's presentational components (src/ui) wired to storage, keys and the chat
// engine. All state that matters lives in SQLite; this holds only what's on screen.
import { CircleAlert, EyeOff, Folder, PanelLeft, Pencil, X } from "lucide-react";
import { Tooltip } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  findModel,
  parseCatalog,
  type Catalog,
  type CatalogModel,
  type ProviderId,
} from "@/catalog/catalog";
import {
  compareModels,
  CUSTOM_MODELS_SETTING,
  MODEL_CHECK_DAYS,
  MODEL_CHECK_SETTING,
  parseCustomModels,
  parseModelCheck,
  PRICING_PAGE,
  withCustomModels,
  type ModelCheck,
} from "@/catalog/discovery";
import {
  applyEdits,
  baseCatalog,
  diffPrices,
  EDITS_SETTING,
  FETCHED_SETTING,
  modelKey,
  oldestPriceDays,
  parseEdits,
  PRICES_URL,
  STALE_DAYS,
  type PriceEdits,
} from "@/catalog/prices";
import { priceToMicro } from "@/cost/cost";
import type { FilesApi } from "@/files/api";
import { LARGE_TEXT_TOKENS, MAX_TEXT_TOKENS } from "@/files/documents";
import { embeddingModel } from "@/knowledge/embed";
import { imageTokens, type PreparedImage } from "@/files/images";
import {
  effectiveInstructions,
  instructionTokens,
  MAX_INSTRUCTION_CHARS,
} from "@/chat/instructions";
import {
  editQuestion,
  escalateLast,
  PROVIDER_NAMES,
  regenerate,
  retryLast,
  sendMessage,
  type ChatDeps,
} from "@/chat/sendMessage";
import { housekeepingModel } from "@/chat/housekeeping";
import { classify } from "@/routing/classify";
import {
  checkPolicy,
  chooseTier,
  serializePolicy,
  tierModels,
  tierOf,
  TIER_ORDER,
  type RoutingPolicy,
  type TierId,
} from "@/routing/policy";
import { AUTO, modeOf, route, type RouteMode } from "@/routing/route";
import { autoTitle, wantsAutoTitle } from "@/chat/title";
import { maybeSummarize, pathTokens, summaryThreshold } from "@/chat/summary";
import { activeSummary, listSummaries } from "@/storage/summaries";
import { needsMemoryCheck, suggestMemories } from "@/memory/extract";
import { memoriesFromText } from "@/memory/importMemories";
import { memoryTokens } from "@/memory/inject";
import { findSecret, SECRET_LABELS } from "@/memory/secrets";
import type { KeysApi, KeyTestResult } from "@/keys/api";
import type { ProviderAdapter } from "@/providers/types";
import type { Tenant } from "@/storage/defaults";
import { citationsForMessages, fileCitationsForMessages, type Citation } from "@/storage/citations";
import { filesForMessages, type FileRecord } from "@/storage/files";
import {
  getGlobalInstructions,
  NO_INSTRUCTIONS,
  setGlobalInstructions,
  type GlobalInstructions,
} from "@/storage/instructions";
import {
  addMemory,
  addProposals,
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
  setThreadArchived,
  setThreadInstructions,
  setThreadPinned,
  setThreadTags,
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
import { PolicyEditor } from "@/ui/PolicyEditor";
import { parseGoldenSet, summarize, type GoldenPrompt } from "@/routing/golden";
import { compareOnGoldenSet, scoreGoldenSet } from "@/routing/evaluate";
import {
  loadPolicy,
  loadProjectRules,
  POLICY_SETTING,
  PROJECT_RULES_SETTING,
  readPolicyFile,
  rulesToRaw,
  withProjectRules,
} from "@/routing/policyStore";
import { listGoldenPrompts, replaceGoldenPrompts } from "@/storage/goldenPrompts";
import {
  GlobalInstructionsSection,
  InstructionsButton,
  ThreadInstructionsDialog,
} from "@/ui/Instructions";
import { MemoryBar, MemoryReviewDialog, MemorySection } from "@/ui/Memory";
import { CATEGORY_LABELS } from "@/ui/memoryLabels";
import { ProjectDialog, type KnowledgeFileView } from "@/ui/Projects";
import { ArtifactPanel, type ArtifactView } from "@/ui/Artifacts";
import {
  addVersion,
  listArtifacts,
  listVersions,
  type Artifact,
  type ArtifactVersion,
  setArtifactCdn,
} from "@/storage/artifacts";
import { diffLines } from "@/artifacts/diff";
import { artifactsIn, splitAnswer } from "@/artifacts/parse";
import {
  addProjectFile,
  listProjectFiles,
  removeProjectFile,
  type ProjectFile,
} from "@/storage/projectFiles";
import { ensureIndexed } from "@/knowledge/retrieve";
import { prepareDocument } from "@/files/documents";
import { addFile } from "@/storage/files";
import { SearchDialog, type SearchHitView } from "@/ui/Search";
import { CommandPalette, type PaletteItem } from "@/ui/Palette";
import { QuickCaptureSection } from "@/ui/QuickCapture";
import { DataSection } from "@/ui/DataSection";
import { ImportPaste } from "@/ui/ImportPaste";
import { ModelsSection } from "@/ui/Models";
import { PricesSection } from "@/ui/Prices";
import { ImportSection, type ImportSourceView } from "@/ui/ImportSection";
import { previewImport, writeImport, type ImportedChat, type ImportSource } from "@/import/write";
import { readChatGptExport } from "@/import/chatgpt";
import { readClaudeExport, type ImportedProject } from "@/import/claude";
import { AppLockSection, LockScreen } from "@/ui/AppLock";
import { hashPasscode, lockoutSeconds, MIN_LENGTH, verifyPasscode } from "@/security/passcode";
import { exportAll } from "@/data/exportAll";
import { deleteAllData } from "@/data/deleteAll";
import { DEFAULT_SHORTCUT, SHORTCUT_SETTING, type QuickCaptureApi } from "./quickCapture";
import { useAppearance, type ZoomApi } from "./appearance";
import { BudgetsSection, type BudgetView } from "@/ui/Budgets";
import {
  addBudget,
  allowBudgetUntil,
  dailySpend,
  deleteBudget,
  listBudgets,
  recordAlert,
  spentSince,
  type Budget,
} from "@/storage/budgets";
import {
  alertLevel,
  budgetState,
  isAnomaly,
  periodEnd,
  periodStart,
  sendGate,
  type BudgetState,
} from "@/cost/budget";
import { UsageScreen, type SavingsView, type UsagePeriod, type UsageScreenView } from "@/ui/Usage";
import {
  bestExtraSince,
  cacheTokensSince,
  listUsage,
  type UsageRecord,
} from "@/storage/usageReport";
import { cacheSavings } from "@/cost/savings";
import { getSetting, setSetting } from "@/storage/settings";
import { PERIOD_DAYS, usageReport, type Dimension } from "@/cost/report";
import { INTENT_LABELS } from "@/routing/classify";
import { Sidebar } from "@/ui/Sidebar";
import { TagsDialog } from "@/ui/Tags";
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
import type { WebApi } from "@/web/api";
import type { PreviewApi } from "@/artifacts/preview";
import {
  extensionFor,
  fileName,
  markdownToDocx,
  markdownToPdf,
  type ExportApi,
} from "@/artifacts/export";
import { useKeys } from "./useKeys";
import { useTheme } from "./useTheme";
import { useUpdate } from "./useUpdate";
import {
  cacheHitRate,
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
  /** Reads pasted links (FK-06). */
  web?: WebApi;
  /** Live previews of HTML artifacts (AR-05). */
  preview?: PreviewApi;
  /** "Save as…" for artifact exports (AR-04). */
  exporter?: ExportApi;
  /** The global quick-capture shortcut (CH-08, PL-07). */
  quickCapture?: QuickCaptureApi;
  zoom?: ZoomApi;
  /** Starts the app over (after delete-all); a page reload by default. */
  onRestart?: () => void;
}

const LAST_THREAD_KEY = "fuse.lastThread";

function readLastThread(): string | null {
  try {
    return localStorage.getItem(LAST_THREAD_KEY);
  } catch {
    return null;
  }
}
/**
 * AR-03: an "Ask AI to edit" request, sent as an ordinary message so it routes and is costed like
 * one. The model answers with the whole artifact under the same id, which becomes a new version.
 */
function artifactEditRequest(
  a: { key: string; title: string },
  selection: string,
  instruction: string,
): string {
  return selection
    ? `Edit the artifact "${a.title}" (id ${a.key}). Change only this part:\n\n> ${selection.split("\n").join("\n> ")}\n\n${instruction}\n\nReply with the whole updated artifact, same id.`
    : `Edit the artifact "${a.title}" (id ${a.key}): ${instruction}\n\nReply with the whole updated artifact, same id.`;
}

/** PL-08: where chats can be imported from. */
const IMPORT_SOURCES: ImportSourceView[] = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    hint: "the zip ChatGPT emails you (Settings → Data controls → Export data)",
    accept: ".zip,.json",
  },
  {
    id: "claude",
    label: "Claude",
    hint: "the zip Claude emails you (Settings → Privacy → Export data)",
    accept: ".zip,.json",
  },
];

/** Reads an export file for a source; throws a plain-English error. */
function readExport(
  source: string,
  bytes: Uint8Array,
  name: string,
): { chats: ImportedChat[]; projects: ImportedProject[] } {
  if (source === "chatgpt") return { chats: readChatGptExport(bytes, name), projects: [] };
  if (source === "claude") return readClaudeExport(bytes, name);
  throw new Error("That source isn't supported.");
}

/** SE-03: settings keys for the app lock, and the default idle time before it locks. */
const LOCK_HASH = "lock.passcode_hash";
const LOCK_IDLE = "lock.idle_minutes";
const DEFAULT_IDLE_MINUTES = 15;

/** CO-05: new content (question plus attachments) above this many tokens shows its cost first. */
const BIG_REQUEST_TOKENS = 20_000;

/** How long the composer mentions a provider's failure (MM-06). */
const TROUBLE_SHOWN_MS = 10 * 60_000;

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
  catalog: shippedCatalog,
  policy: shippedPolicy,
  keysApi,
  adapterFor,
  files,
  prepareImage,
  updates,
  recoveryKey,
  web,
  preview,
  exporter,
  quickCapture,
  zoom,
  onRestart = () => {
    window.location.reload();
  },
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
  // The chat's artifacts (AR-01), and the one open in the side panel, by key.
  const [threadArtifacts, setThreadArtifacts] = useState<Artifact[]>([]);
  const [openArtifact, setOpenArtifact] = useState<string | null>(null);
  // AR-02: the open artifact's versions, the one on screen (null = latest) and a diff base.
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  const [shownVersion, setShownVersion] = useState<number | null>(null);
  const [compareWith, setCompareWith] = useState<number | null>(null);
  // AR-03: after an AI edit lands, show it as a diff against the version it changed.
  const editFrom = useRef<{ key: string; version: number } | null>(null);
  // The last message the model gets as a summary rather than in full (PM-06), on this path.
  const [summaryUpto, setSummaryUpto] = useState<string | null>(null);
  // Files attached to the messages on screen, by message id.
  const [threadFiles, setThreadFiles] = useState<Map<string, FileRecord[]>>(new Map());
  // Web sources cited by the answers on screen, by message id.
  const [threadSources, setThreadSources] = useState<Map<string, Citation[]>>(new Map());
  // Parts of large files the answers on screen were given, by message id (FK-02).
  const [threadFileSources, setThreadFileSources] = useState<Map<string, string[]>>(new Map());
  // Memories sent with the answers on screen, by message id.
  const [threadMemories, setThreadMemories] = useState<Map<string, { text: string }[]>>(new Map());
  // Memory (step 7): saved facts, suggestions waiting, and what the last check skipped as secrets.
  // MM-04: a newer fetched price list and your own edits, on top of the shipped catalog.
  const [fetchedPrices, setFetchedPrices] = useState<string | null>(null);
  const [priceEdits, setPriceEdits] = useState<PriceEdits>({});
  const [pricesNoticeOff, setPricesNoticeOff] = useState(false);
  // MM-03/MM-08: models you added, and the last read of the providers' model lists.
  const [customModels, setCustomModels] = useState<CatalogModel[]>([]);
  const [modelCheck, setModelCheck] = useState<ModelCheck | null | undefined>(undefined);
  const [modelsNoticeOff, setModelsNoticeOff] = useState(false);
  // RT-03: your saved policy and per-project rules (raw JSON from settings).
  const [savedPolicy, setSavedPolicy] = useState<string | null>(null);
  const [projectRulesRaw, setProjectRulesRaw] = useState<string | null>(null);
  const catalog = useMemo(
    () =>
      applyEdits(
        withCustomModels(baseCatalog(shippedCatalog, fetchedPrices), customModels),
        priceEdits,
      ),
    [shippedCatalog, fetchedPrices, customModels, priceEdits],
  );
  const checkedPrices = useRef<string | null>(null);
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
  // The open project's knowledge files (PM-09), and what adding or indexing them is doing.
  const [knowledge, setKnowledge] = useState<{
    projectId: string;
    files: ProjectFile[];
    busy: boolean;
    error: string | null;
  } | null>(null);
  const [live, setLive] = useState<Record<string, LiveAnswer>>({});
  // A provider that failed recently, so the composer can say so (MM-06).
  const [trouble, setTrouble] = useState<{ provider: ProviderId; at: number } | null>(null);
  useEffect(() => {
    if (!trouble) return;
    const timer = setTimeout(() => {
      setTrouble(null);
    }, TROUBLE_SHOWN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [trouble]);
  // Budgets (CO-03), their state for Settings, alerts waiting to be seen, and a send waiting for
  // "over budget, send anyway?".
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [budgetStates, setBudgetStates] = useState<BudgetState[]>([]);
  const [alerts, setAlerts] = useState<string[]>([]);
  const [overAsk, setOverAsk] = useState<{
    state: BudgetState;
    text: string;
    thinkHarder: boolean;
  } | null>(null);
  // A big message waiting for "this costs about $X, send?" (CO-05).
  const [bigAsk, setBigAsk] = useState<{
    text: string;
    thinkHarder: boolean;
    overConfirmed: boolean;
    added: number;
    micro: number;
    model: string;
    files: number;
  } | null>(null);
  // The usage dashboard (CO-02): its period and the calls it covers.
  const [usagePeriod, setUsagePeriod] = useState<UsagePeriod>("week");
  const [usage, setUsage] = useState<{ rows: UsageRecord[]; at: number } | null>(null);
  const [savings, setSavings] = useState<SavingsView | null>(null);
  // SE-03: the app lock. `hash` is the stored passcode hash (null = off, undefined = loading).
  const [lock, setLock] = useState<{
    hash: string | null | undefined;
    idleMinutes: number;
    locked: boolean;
    wrongTries: number;
    waitUntil: number;
  }>({
    hash: undefined,
    idleMinutes: DEFAULT_IDLE_MINUTES,
    locked: false,
    wrongTries: 0,
    waitUntil: 0,
  });
  const lastActive = useRef(Date.now());
  // PL-08: chats read from an export, waiting for "Import".
  const pendingImport = useRef<{
    source: ImportSource;
    chats: ImportedChat[];
    projects: ImportedProject[];
  } | null>(null);
  // Quick capture (CH-08): the active shortcut, and what the desktop said about it.
  const [shortcut, setShortcut] = useState<{
    shortcut: string | null;
    mayNotWork: boolean;
    error: string | null;
  }>({ shortcut: null, mayNotWork: false, error: null });
  // The command palette (CH-08).
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Search across chats (CH-02), and the message a result opened at.
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  // An answer quoted into the composer; `key` changes on every quote.
  const [quote, setQuote] = useState<{ text: string; key: number } | null>(null);
  // The composer's mode for a chat that hasn't been saved yet (RT-01); saved chats keep theirs.
  const [draftMode, setDraftMode] = useState<RouteMode>(AUTO);
  // RT-01: "next message only" is armed in the picker; the pick then goes here, not the chat.
  const [onceArmed, setOnceArmed] = useState(false);
  const [oneShot, setOneShot] = useState<RouteMode | null>(null);
  const [view, setView] = useState<"chat" | "settings" | "usage">(
    import.meta.env.VITE_FUSE_VIEW === "settings"
      ? "settings"
      : import.meta.env.VITE_FUSE_VIEW === "usage"
        ? "usage"
        : "chat",
  );
  const [sidebar, setSidebar] = useState(() => window.innerWidth >= 800);
  const [picker, setPicker] = useState(false);
  const [deleting, setDeleting] = useState<ThreadView | null>(null);
  const [tagging, setTagging] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [log, setLog] = useState<RequestRow[] | null>(null);
  const [theme, setTheme] = useTheme();
  const appearance = useAppearance(zoom);
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
  const filesApi = files;
  const attachments = useAttachments({ db, tenant, files, prepareImage, ...(web ? { web } : {}) });

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
    Promise.all([
      getSetting(db, tenant, FETCHED_SETTING),
      getSetting(db, tenant, EDITS_SETTING),
      getSetting(db, tenant, CUSTOM_MODELS_SETTING),
      getSetting(db, tenant, MODEL_CHECK_SETTING),
      getSetting(db, tenant, POLICY_SETTING),
      getSetting(db, tenant, PROJECT_RULES_SETTING),
    ]).then(([fetched, edits, custom, check, savedRouting, projectRouting]) => {
      setSavedPolicy(savedRouting);
      setProjectRulesRaw(projectRouting);
      setFetchedPrices(fetched);
      setPriceEdits(parseEdits(edits));
      setCustomModels(parseCustomModels(custom));
      setModelCheck(parseModelCheck(check));
    }, report);
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
      const fromFiles = await fileCitationsForMessages(db, tenant, answers);
      const used = await memoriesForMessages(db, tenant, answers);
      const upto = activeSummary(rows, await listSummaries(db, tenant, threadId))?.summary
        .uptoMessageId;
      const artifacts = await listArtifacts(db, tenant, threadId);
      return { rows, all, attached, cited, used, upto: upto ?? null, fromFiles, artifacts };
    },
    [db, tenant],
  );
  /** Reloads a thread's messages if it's still the one on screen. */
  const reload = useCallback(
    async (threadId: string) => {
      const { rows, all, attached, cited, used, upto, fromFiles, artifacts } =
        await loadThread(threadId);
      if (selectedRef.current === threadId) {
        setThreadArtifacts(artifacts);
        setThreadFileSources(fromFiles);
        setMessages(rows);
        setSummaryUpto(upto);
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
        const { rows, all, attached, cited, used, upto, fromFiles, artifacts } =
          await loadThread(lastThread);
        if (selectedRef.current !== null) return; // the user already moved on
        setThreadArtifacts(artifacts);
        setThreadFileSources(fromFiles);
        setSelectedId(lastThread);
        selectedRef.current = lastThread;
        setMessages(rows);
        setSummaryUpto(upto);
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
    setOneShot(null);
    setOnceArmed(false);
    setSelectedId(id);
    selectedRef.current = id;
    setView("chat");
    setMessages([]);
    setThreadArtifacts([]);
    setOpenArtifact(null);
    setSummaryUpto(null);
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
      setThreadArtifacts([]);
      setOpenArtifact(null);
      setSummaryUpto(null);
      setThreadAll([]);
      setThreadBranches(new Map());
      setThreadFiles(new Map());
      setThreadSources(new Map());
      setThreadMemories(new Map());
      setThreadMemories(new Map());
      setDraftSearch(true);
      setDraftIncognito(incognito);
      setOneShot(null);
      setOnceArmed(false);
      setDraftInstructions("");
      setDraftProject(projectId);
      // A project's default model pins new chats in it; otherwise they start on Auto.
      const project = projects.find((p) => p.id === projectId);
      const preferred = project?.defaultModel;
      const tier = project?.defaultTier;
      setDraftMode(
        preferred ? { kind: "model", ...preferred } : tier ? { kind: "tier", tier } : AUTO,
      );
      clearAttachments();
      setView("chat");
    },
    [clearAttachments, projects],
  );

  const globalPolicy = useMemo(
    () => loadPolicy(shippedPolicy, savedPolicy, catalog),
    [shippedPolicy, savedPolicy, catalog],
  );
  const projectRules = useMemo(
    () => loadProjectRules(globalPolicy, projectRulesRaw),
    [globalPolicy, projectRulesRaw],
  );
  // The chat on screen's project adds its own rules first (RT-03).
  const routingProject = selectedId
    ? (threads.find((t) => t.id === selectedId)?.projectId ?? null)
    : draftProject;
  const policy = useMemo(
    () =>
      withProjectRules(
        globalPolicy,
        routingProject === null ? undefined : projectRules[routingProject],
      ),
    [globalPolicy, projectRules, routingProject],
  );
  const savedProviders = keys.keys.filter((k) => k.saved).map((k) => k.provider);
  /** Reads the providers' model lists (free calls) and compares them with the catalog. */
  const checkModels = async () => {
    const lists = Object.fromEntries(
      await Promise.all(
        savedProviders.map(async (p) => [
          p,
          await adapterFor(p)
            .listModels()
            .catch(() => null),
        ]),
      ),
    ) as Partial<Record<ProviderId, Awaited<ReturnType<ProviderAdapter["listModels"]>> | null>>;
    const check = compareModels(catalog, policy, lists, Date.now());
    setModelCheck(check);
    await setSetting(db, tenant, MODEL_CHECK_SETTING, JSON.stringify(check));
  };
  const modelsDue =
    modelCheck !== undefined &&
    savedProviders.length > 0 &&
    (modelCheck === null || Date.now() - modelCheck.checkedAt > MODEL_CHECK_DAYS * 86_400_000);
  const autoChecked = useRef(false);
  useEffect(() => {
    if (!modelsDue || autoChecked.current) return;
    autoChecked.current = true;
    void checkModels().catch(report);
  });
  const openThread = threads.find((t) => t.id === selectedId);
  /** Auto, a pinned tier, or a pinned model (RT-01): saved per chat. */
  const savedMode: RouteMode = openThread ? modeOf(openThread) : draftMode;
  // RT-01: a pin for the next message only overrides the chat's mode, then clears.
  const mode: RouteMode = oneShot ?? savedMode;
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
    if (onceArmed) {
      setOneShot(next);
      return;
    }
    setOneShot(null);
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
  const routeFor = (
    text: string,
    files: FileRecord[],
    history: Message[],
    webSearch: boolean,
    downshift = false,
  ) => {
    const task = classify(classifyInput(text, files, history, webSearch));
    const routed = route(policy, catalog, mode, task, {
      providers: savedProviders,
      ...(stayOn ? { prefer: stayOn } : {}),
      downshift,
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

  /** After an answer: once the thread nears what its model takes, older turns get summarized. */
  const summarizeIfLong = (threadId: string, answeredBy: CatalogModel) => {
    const helper = housekeepingModel(
      policy,
      catalog,
      "summary",
      savedProviders,
      answeredBy.provider,
    );
    if (!helper) return;
    maybeSummarize(deps, catalog, threadId, helper, summaryThreshold(answeredBy))
      .then(async (r) => {
        if (r.summarized) await reload(threadId);
      })
      .catch(report);
  };

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
      fallback: routed.fallback,
      embedding: embeddingModel(catalog, savedProviders),
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
      const result = await (job.kind === "send"
        ? sendMessage(deps, {
            ...input,
            text: job.text,
            fileIds: job.files.map((f) => f.id),
            fileModes: Object.fromEntries(job.files.map((f) => [f.id, f.mode ?? "whole"])),
          })
        : job.kind === "retry"
          ? retryLast(deps, input)
          : job.kind === "escalate"
            ? escalateLast(deps, input)
            : job.kind === "regenerate"
              ? regenerate(deps, { ...input, answerId: job.answerId })
              : editQuestion(deps, { ...input, messageId: job.messageId, text: job.text }));
      if (result.failedOverFrom) {
        setTrouble({ provider: result.failedOverFrom, at: Date.now() });
      } else if (result.status === "complete" && trouble?.provider === routed.model.provider) {
        setTrouble(null);
      }
    } catch (e) {
      report(e);
    } finally {
      controllers.current.delete(threadId);
      const rows = await reload(threadId).catch(report);
      if (rows) {
        // A new or updated artifact opens in the panel when its answer finishes.
        const made = artifactsIn(rows.findLast((m) => m.role === "assistant")?.content ?? "").at(
          -1,
        );
        if (made && selectedRef.current === threadId) {
          showArtifact(made.key);
          if (editFrom.current?.key === made.key) setCompareWith(editFrom.current.version);
        }
        editFrom.current = null;
        nameThread(threadId, rows);
        summarizeIfLong(threadId, routed.model);
      }
      checkAlerts().catch(report);
      setLive((all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== threadId)));
      await refreshThreads().catch(report);
    }
  };

  const send = async (
    text: string,
    thinkHarder = false,
    confirmed: { over?: boolean; big?: boolean; dropFiles?: boolean } = {},
  ) => {
    const ready = confirmed.dropFiles
      ? []
      : attachments.pending.flatMap((p) =>
          p.status === "ready" && p.file
            ? [{ ...p.file, ...(p.mode ? { mode: p.mode } : {}) }]
            : [],
        );
    // FK-02: searching a file embeds it, and only OpenAI has embeddings.
    const embedding = embeddingModel(catalog, savedProviders);
    if (!embedding && ready.some((f) => f.mode === "retrieval")) {
      setProblem(
        "Searching inside a large file needs an OpenAI key (Anthropic has no embeddings). Add one in Settings, or switch the file to Whole.",
      );
      return;
    }
    const search = searchOn;
    // CO-03 / RT-10: budgets past 80% lower Auto a tier; past 100% the send asks first.
    const gate = sendGate(await budgetStatesFor(budgets, activeProjectId));
    if (gate.over && !confirmed.over) {
      setOverAsk({ state: gate.over, text, thinkHarder });
      return;
    }
    const found = routeFor(text, ready, messages, search, gate.downshift !== null);
    if (!found) return;
    // CO-05: a message that adds a lot (a long paste, big files) shows its cost first. The
    // history alone doesn't count: it's resent every turn and mostly read from cache.
    const added = classifyInput(text, ready, [], false).contextTokens ?? 0;
    if (added > BIG_REQUEST_TOKENS && !confirmed.big) {
      const total = classifyInput(text, ready, messages, false).contextTokens ?? added;
      setBigAsk({
        text,
        thinkHarder,
        overConfirmed: Boolean(confirmed.over),
        added,
        micro: Math.round((total * priceToMicro(found.model.price.input)) / 1_000_000),
        model: found.model.displayName,
        files: ready.length,
      });
      return;
    }
    // RT-08: "Think harder" asks for the most reasoning the model has, for this message only.
    const routed = thinkHarder
      ? {
          ...found,
          info: {
            ...found.info,
            effort: "max" as const,
            reason: `${found.info.reason}; you asked it to think harder`,
          },
        }
      : found;
    const sent = confirmed.dropFiles ? [] : attachments.take();
    // A one-message pin is used up by this send.
    setOneShot(null);
    setOnceArmed(false);
    if (confirmed.dropFiles) attachments.clear();
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
  /**
   * A Claude project: found or made by name; its instructions fill an empty project's, and its
   * documents become knowledge files (searched when used, PM-09) unless one of that name is there.
   */
  const importProject = async (p: ImportedProject) => {
    const id = await projectIdFor(p.name);
    const project = (await listProjects(db, tenant)).find((x) => x.id === id);
    if (project && !project.instructions && p.instructions) {
      await updateProject(db, tenant, id, { ...project, instructions: p.instructions });
    }
    const have = new Set((await listProjectFiles(db, tenant, id)).map((f) => f.name));
    for (const doc of p.docs.filter((d) => !have.has(d.name))) {
      const bytes = new TextEncoder().encode(doc.text);
      const stored = await filesApi.put(bytes);
      const file = await addFile(db, tenant, {
        name: doc.name,
        mime: "text/plain",
        sizeBytes: stored.size,
        sha256: stored.sha256,
        tokenEstimate: Math.ceil(doc.text.length / 4),
      });
      await addProjectFile(db, tenant, id, file.id);
    }
  };
  /** An imported chat's project, by name: an existing one, or a new one (Claude projects). */
  const projectIdFor = async (name: string) => {
    const found = (await listProjects(db, tenant)).find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
    return found?.id ?? (await createProject(db, tenant, name)).id;
  };
  useEffect(() => {
    if (!projectDialog || projectDialog === "new") return;
    const projectId = projectDialog;
    listProjectFiles(db, tenant, projectId).then((files) => {
      setKnowledge({ projectId, files, busy: false, error: null });
    }, report);
  }, [projectDialog, db, tenant]);
  /** Indexes a project's files that aren't fully searchable yet (needs an OpenAI key). */
  const indexKnowledge = async (projectId: string) => {
    const model = embeddingModel(catalog, savedProviders);
    const files = await listProjectFiles(db, tenant, projectId);
    if (model) {
      for (const f of files.filter((x) => x.chunks === 0 || x.embedded < x.chunks)) {
        await ensureIndexed(
          { db, tenant, adapterFor, files: filesApi, priceVersion: catalog.priceVersion },
          model,
          f,
        );
      }
    }
    return listProjectFiles(db, tenant, projectId);
  };
  const addKnowledge = (projectId: string, list: File[]) => {
    setKnowledge((k) => (k ? { ...k, busy: true, error: null } : k));
    void (async () => {
      const problems: string[] = [];
      for (const f of list) {
        try {
          const doc = await prepareDocument(f, { searchPdf: true });
          const stored = await filesApi.put(doc.bytes);
          const file = await addFile(db, tenant, {
            name: f.name,
            mime: doc.mime,
            sizeBytes: stored.size,
            sha256: stored.sha256,
            tokenEstimate: doc.tokens,
          });
          await addProjectFile(db, tenant, projectId, file.id);
        } catch (e) {
          problems.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      setKnowledge((k) => (k ? { ...k, error: problems.length ? problems.join(" ") : null } : k));
      try {
        const files = await indexKnowledge(projectId);
        setKnowledge((k) => (k ? { ...k, files, busy: false } : k));
      } catch (e) {
        const files = await listProjectFiles(db, tenant, projectId);
        setKnowledge((k) =>
          k ? { ...k, files, busy: false, error: e instanceof Error ? e.message : String(e) } : k,
        );
      }
    })();
  };
  const knowledgeViews: KnowledgeFileView[] = (knowledge?.files ?? []).map((f) => {
    const tokens = f.tokenEstimate ?? 0;
    const ready = f.chunks > 0 && f.embedded >= f.chunks;
    return {
      id: f.id,
      name: f.name,
      tokens,
      ready,
      status: ready
        ? "Searchable"
        : !embeddingModel(catalog, savedProviders)
          ? "Needs an OpenAI key"
          : knowledge?.busy
            ? "Indexing…"
            : "Not indexed",
      wholeMicro: Math.round((tokens * priceToMicro(model.price.input)) / 1_000_000),
    };
  });
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
        setDraftMode(
          form.defaultModel
            ? { kind: "model", ...form.defaultModel }
            : form.defaultTier
              ? { kind: "tier", tier: form.defaultTier }
              : AUTO,
        );
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
  const fileUrls = useFileUrls(filesApi, wantedFiles);
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
      const fromFiles = threadFileSources.get(v.id);
      if (fromFiles?.length) v.fileSources = fromFiles;
      const info = threadBranches.get(v.id);
      if (info) v.branch = { position: info.position, total: info.total };
    }
    const after = summaryUpto ? views.findIndex((v) => v.id === summaryUpto) + 1 : 0;
    const firstInFull = after > 0 ? views[after] : undefined;
    if (firstInFull) firstInFull.summaryAbove = true;
    return views;
  }, [
    messages,
    liveHere,
    threadFiles,
    threadSources,
    threadMemories,
    threadBranches,
    threadFileSources,
    summaryUpto,
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
  const openSaved = threadArtifacts.find((a) => a.key === openArtifact);
  useEffect(() => {
    if (!openSaved) return;
    listVersions(db, tenant, openSaved.id).then(setVersions, report);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when a new version lands
  }, [db, tenant, openSaved?.id, openSaved?.version]);
  const showArtifact = (key: string | null) => {
    setOpenArtifact(key);
    setShownVersion(null);
    setCompareWith(null);
  };
  // The open artifact: as it streams in, or its saved latest version.
  const panelArtifact = ((): ArtifactView | null => {
    if (!openArtifact) return null;
    const writing = liveHere
      ? splitAnswer(liveHere.text).find(
          (p) => p.kind === "artifact" && p.artifact.key === openArtifact && !p.artifact.complete,
        )
      : undefined;
    if (writing?.kind === "artifact") return { ...writing.artifact, version: null };
    const saved = openSaved;
    const shown = versions.find((v) => v.version === shownVersion);
    return saved
      ? {
          key: saved.key,
          title: saved.title,
          type: saved.type,
          language: saved.language,
          content: shown?.content ?? saved.content,
          version: saved.version,
          allowCdn: saved.allowCdn,
        }
      : null;
  })();
  const artifactDiff = (() => {
    if (!panelArtifact || compareWith === null) return null;
    const base = versions.find((v) => v.version === compareWith);
    return base ? diffLines(base.content, panelArtifact.content) : null;
  })();
  /** Restores a version or saves an edit: either way a new version on top (AR-02). */
  const newVersion = (content: string, source: "user" | "restore") => {
    const threadId = selectedId;
    if (!openSaved || !threadId) return;
    addVersion(db, tenant, openSaved.id, content, source)
      .then(() => {
        setShownVersion(null);
        setCompareWith(null);
        return reload(threadId);
      })
      .catch(report);
  };
  const keyFor = keys.keys.find((k) => k.provider === model.provider);
  const missingKey = keyFor && !keyFor.saved && keyFor.busy !== "loading" ? keyFor.name : null;
  const cacheRate = cacheHitRate(messages);
  const threadViews = threads.filter((t) => !t.incognito).map((t) => threadView(t, at));
  const togglePin = (t: { id: string; pinned: boolean }) => {
    setThreadPinned(db, tenant, t.id, !t.pinned).then(refreshThreads).catch(report);
  };
  const toggleArchive = (t: { id: string; archived: boolean }) => {
    setThreadArchived(db, tenant, t.id, !t.archived).then(refreshThreads).catch(report);
  };
  const taggingThread = threads.find((t) => t.id === tagging);
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
    const searched = p.mode === "retrieval";
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      kind: isImage ? "image" : "document",
      ...(p.url ? { url: p.url } : {}),
      ...(p.error ? { error: p.error } : {}),
      ...(tokens
        ? {
            detail: searched
              ? `~${number(tokens)} tokens · searched: the best ~3,000 a turn`
              : `${pages}~${number(tokens)} tokens · ${money(micro)} per turn`,
          }
        : {}),
      ...(!isImage && !searched && tokens > LARGE_TEXT_TOKENS ? { large: true } : {}),
      ...(p.mode ? { mode: p.mode, canWhole: tokens <= MAX_TEXT_TOKENS } : {}),
    };
  });
  const sendingImages = attachments.pending.some(
    (p) => p.status !== "error" && (p.file?.mime.startsWith("image/") ?? p.url !== undefined),
  );
  const blocked =
    sendingImages && mode.kind === "model" && !model.capabilities.includes("vision")
      ? `${model.displayName} can't read images. Pick another model (Ctrl+K).`
      : null;

  useEffect(() => {
    listBudgets(db, tenant).then(setBudgets, report);
  }, [db, tenant]);
  /** Every budget that covers this project (or every budget, for Settings), with what's spent. */
  const budgetStatesFor = async (
    list: readonly Budget[],
    projectId: string | null,
    every = false,
  ): Promise<BudgetState[]> => {
    const now = Date.now();
    const applies = list.filter((b) => every || b.projectId === null || b.projectId === projectId);
    return Promise.all(
      applies.map(async (b) =>
        budgetState(b, await spentSince(db, tenant, periodStart(b.period, now), b.projectId), now),
      ),
    );
  };
  const budgetName = (b: Budget) =>
    b.projectId ? (projects.find((p) => p.id === b.projectId)?.name ?? "A project") : "Everything";
  /** After an answer: alerts at 50/80/100% of a budget, and a day far above the usual (CO-07). */
  const checkAlerts = async () => {
    const fresh: string[] = [];
    for (const s of await budgetStatesFor(budgets, null, true)) {
      const level = alertLevel(s.used);
      if (!level) continue;
      const shown = await recordAlert(
        db,
        tenant,
        s.budget.id,
        level,
        periodStart(s.budget.period, Date.now()),
      );
      if (!shown) continue;
      fresh.push(
        `${budgetName(s.budget)}: ${money(s.spent)} of ${money(s.budget.limitMicro)} this ${s.budget.period} (${String(Math.round(s.used * 100))}%).` +
          (level === "100"
            ? " Messages now ask before sending."
            : level === "80"
              ? " Auto now answers one tier lower where it can."
              : ""),
      );
    }
    const today = periodStart("day", Date.now());
    const starts = Array.from({ length: 15 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - 14 + i);
      return d.getTime();
    });
    const days = await dailySpend(db, tenant, starts);
    const spentToday = days.at(-1) ?? 0;
    if (
      isAnomaly(spentToday, days.slice(0, -1)) &&
      (await recordAlert(db, tenant, null, "anomaly", today))
    ) {
      fresh.push(
        `Today's spend (${money(spentToday)}) is more than three times your daily average of the last two weeks.`,
      );
    }
    if (fresh.length > 0) setAlerts((a) => [...a, ...fresh]);
  };
  useEffect(() => {
    if (view !== "settings") return;
    budgetStatesFor(budgets, null, true).then(setBudgetStates, report);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when Settings opens or budgets change
  }, [view, budgets]);
  const budgetViews: BudgetView[] = budgetStates.map((s) => ({
    id: s.budget.id,
    scope: budgetName(s.budget),
    period: s.budget.period,
    limitMicro: s.budget.limitMicro,
    spentMicro: s.spent,
    hardStop: s.budget.hardStop,
    allowed: s.allowed
      ? `Allowed past the limit until ${new Date(s.budget.allowUntil ?? 0).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
      : null,
  }));

  /** CO-04: this calendar month against Best, your subscriptions, and caching. */
  const loadSavings = async (at: number) => {
    const month = periodStart("month", at);
    const [spent, extra, cache, sub] = await Promise.all([
      spentSince(db, tenant, month),
      bestExtraSince(db, tenant, month),
      cacheTokensSince(db, tenant, month),
      getSetting(db, tenant, "savings.subscription_micro"),
    ]);
    setSavings({
      month: new Date(at).toLocaleDateString(undefined, { month: "long" }),
      spent,
      onBest: spent + extra,
      cache: cacheSavings(catalog, cache),
      subscription: sub === null ? null : Number(sub),
    });
  };
  const openUsage = () => {
    setView("usage");
    const at = Date.now();
    // Two of the longest periods back, so "against the 30 days before" has its data.
    const since = at - 2 * PERIOD_DAYS.month * 86_400_000 - 86_400_000;
    listUsage(db, tenant, since).then((rows) => {
      setUsage({ rows, at });
    }, report);
    loadSavings(at).catch(report);
  };
  // Screenshots can open on the dashboard (FUSE_VIEW=usage): load it once at start.
  useEffect(() => {
    if (import.meta.env.VITE_FUSE_VIEW !== "usage") return;
    listUsage(db, tenant, 0).then((rows) => {
      setUsage({ rows, at: Date.now() });
    }, report);
  }, [db, tenant]);
  const usageView = ((): UsageScreenView | null => {
    if (!usage) return null;
    const r = usageReport(usage.rows, usagePeriod, usage.at);
    const intentLabels: Partial<Record<string, string>> = INTENT_LABELS;
    const purposeLabels: Partial<Record<string, string>> = {
      chat: "Answers",
      title: "Chat titles",
      memory: "Memory suggestions",
      summary: "Summaries of long chats",
      key_test: "Key tests",
      classify: "Classification",
      embed: "Embeddings",
    };
    const label: Record<Dimension, (key: string) => string> = {
      provider: (k) => (k === "openai" || k === "anthropic" ? PROVIDER_NAMES[k] : k),
      model: (k) => {
        const [p, ...id] = k.split("/");
        const m =
          p === "openai" || p === "anthropic" ? findModel(catalog, p, id.join("/")) : undefined;
        return m?.displayName ?? id.join("/");
      },
      tier: (k) =>
        k ? (policy.tiers.find((t) => t.id === k)?.label ?? k) : "No tier (housekeeping)",
      project: (k) =>
        k ? (projects.find((p) => p.id === k)?.name ?? "Deleted project") : "No project",
      intent: (k) => (k ? (intentLabels[k] ?? k) : "Not classified"),
      purpose: (k) => purposeLabels[k] ?? k,
    };
    const titles: [Dimension, string][] = [
      ["model", "model"],
      ["tier", "tier"],
      ["project", "project"],
      ["intent", "kind of question"],
      ["provider", "provider"],
      ["purpose", "purpose"],
    ];
    const day = (ms: number) =>
      new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return {
      period: usagePeriod,
      total: r.current,
      previous: r.previous,
      calls: r.calls,
      bars: r.buckets.map((b) => ({
        label:
          usagePeriod === "day"
            ? new Date(b.start).toLocaleTimeString([], { hour: "numeric" })
            : day(b.start),
        micro: b.micro,
      })),
      sections: titles.map(([dim, title]) => ({
        title,
        rows: r.groups[dim].map((g) => ({
          label: label[dim](g.key),
          micro: g.micro,
          calls: g.calls,
        })),
      })),
    };
  })();
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

  // SE-03: locked at start when a passcode is set.
  useEffect(() => {
    Promise.all([getSetting(db, tenant, LOCK_HASH), getSetting(db, tenant, LOCK_IDLE)]).then(
      ([hash, idle]) => {
        const minutes = idle === null ? DEFAULT_IDLE_MINUTES : Number(idle);
        setLock((l) => ({
          ...l,
          hash: hash || null,
          idleMinutes: Number.isFinite(minutes) ? minutes : DEFAULT_IDLE_MINUTES,
          locked: Boolean(hash),
        }));
      },
      (e: unknown) => {
        setLock((l) => ({ ...l, hash: null }));
        report(e);
      },
    );
  }, [db, tenant]);
  // ...and again after being left alone for the chosen time.
  useEffect(() => {
    if (!lock.hash || lock.idleMinutes <= 0) return;
    const touch = () => {
      lastActive.current = Date.now();
    };
    const events = ["pointerdown", "keydown", "mousemove", "wheel"] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    const timer = setInterval(() => {
      if (Date.now() - lastActive.current > lock.idleMinutes * 60_000) {
        setLock((l) => (l.locked ? l : { ...l, locked: true }));
      }
    }, 15_000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      clearInterval(timer);
    };
  }, [lock.hash, lock.idleMinutes]);
  const unlock = async (passcode: string) => {
    if (!lock.hash) return true;
    const ok = await verifyPasscode(passcode, lock.hash);
    setLock((l) => {
      const wrongTries = ok ? 0 : l.wrongTries + 1;
      lastActive.current = Date.now();
      return {
        ...l,
        locked: !ok,
        wrongTries,
        waitUntil: ok ? 0 : Date.now() + lockoutSeconds(wrongTries) * 1000,
      };
    });
    return ok;
  };
  /** Settings: set or change the passcode (the current one is checked first). */
  const setPasscode = async (next: string, current: string | null) => {
    if (lock.hash && !(current && (await verifyPasscode(current, lock.hash)))) {
      return "The current passcode isn't right.";
    }
    const hash = await hashPasscode(next);
    await setSetting(db, tenant, LOCK_HASH, hash);
    setLock((l) => ({ ...l, hash }));
    return null;
  };
  const removePasscode = async (current: string) => {
    if (!lock.hash || !(await verifyPasscode(current, lock.hash))) {
      return "The current passcode isn't right.";
    }
    await setSetting(db, tenant, LOCK_HASH, "");
    setLock((l) => ({ ...l, hash: null }));
    return null;
  };

  /** Applies a quick-capture shortcut (null = off) and remembers it. */
  const applyShortcut = useCallback(
    async (value: string | null, save: boolean) => {
      if (!quickCapture) return;
      try {
        const status = await quickCapture.set(value);
        setShortcut({ ...status, error: null });
        if (save) await setSetting(db, tenant, SHORTCUT_SETTING, value ?? "off");
      } catch (e) {
        setShortcut((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      }
    },
    [quickCapture, db, tenant],
  );
  useEffect(() => {
    if (!quickCapture) return;
    getSetting(db, tenant, SHORTCUT_SETTING).then(
      (saved) => applyShortcut(saved === "off" ? null : (saved ?? DEFAULT_SHORTCUT), false),
      report,
    );
  }, [quickCapture, db, tenant, applyShortcut]);
  // The shortcut was pressed anywhere: a new chat, ready to type.
  const newChatRef = useRef(newChat);
  useEffect(() => {
    newChatRef.current = newChat;
  });
  useEffect(() => {
    if (!quickCapture) return;
    let stop: (() => void) | null = null;
    let gone = false;
    void quickCapture
      .onCapture(() => {
        newChatRef.current();
        setTimeout(() => {
          document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus();
        }, 50);
      })
      .then(
        (unlisten) => {
          if (gone) unlisten();
          else stop = unlisten;
        },
        () => undefined, // outside the desktop app there's no event bus to listen on
      );
    return () => {
      gone = true;
      stop?.();
    };
  }, [quickCapture]);

  /** CH-08: everything the app can do, plus recent chats, for the palette. */
  const paletteItems: PaletteItem[] = [
    {
      id: "new",
      group: "Actions",
      label: "New chat",
      shortcut: "Ctrl N",
      run: () => {
        newChat();
      },
    },
    {
      id: "incognito",
      group: "Actions",
      label: "New incognito chat",
      shortcut: "Ctrl ⇧ N",
      run: () => {
        newChat(null, true);
      },
    },
    {
      id: "search",
      group: "Actions",
      label: "Search chats",
      shortcut: "Ctrl ⇧ F",
      run: () => {
        setSearchOpen(true);
      },
    },
    {
      id: "model",
      group: "Actions",
      label: "Choose model or tier",
      shortcut: "Ctrl K",
      run: () => {
        setView("chat");
        setPicker(true);
      },
    },
    ...(["auto", "balanced", "best"] as const).map((choice) => ({
      id: `mode-${choice}`,
      group: "Mode",
      label: choice === "auto" ? "Auto" : `${choice === "best" ? "Best" : "Balanced"} tier`,
      run: () => {
        chooseMode(choice === "auto" ? AUTO : { kind: "tier", tier: choice });
      },
    })),
    {
      id: "web",
      group: "Actions",
      label: searchOn ? "Turn web search off" : "Turn web search on",
      run: toggleSearch,
    },
    {
      id: "sidebar",
      group: "View",
      label: sidebar ? "Hide sidebar" : "Show sidebar",
      shortcut: "Ctrl B",
      run: () => {
        setSidebar((open) => !open);
      },
    },
    {
      id: "settings",
      group: "View",
      label: "Settings",
      shortcut: "Ctrl ,",
      run: () => {
        setView("settings");
      },
    },
    { id: "usage", group: "View", label: "Usage and savings", run: openUsage },
    ...(["light", "dark", "system"] as const).map((t) => ({
      id: `theme-${t}`,
      group: "View",
      label: `Theme: ${t}`,
      run: () => {
        setTheme(t);
      },
    })),
    ...(thread && !thread.incognito
      ? [
          {
            id: "memories",
            group: "Actions",
            label: "Suggest memories from this chat",
            run: () => {
              checkMemory(thread.id, true).catch(report);
            },
          },
          { id: "rename", group: "Actions", label: "Rename this chat", run: showRename },
        ]
      : []),
    ...threads
      .filter((t) => !t.incognito && t.id !== selectedId)
      .slice(0, 30)
      .map((t) => ({
        id: `chat-${t.id}`,
        group: "Chats",
        label: t.title,
        run: () => {
          select(t.id);
        },
      })),
  ];

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
        } else if (key === "p" && event.shiftKey) {
          event.preventDefault();
          setPaletteOpen((open) => !open);
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

  // SE-03: nothing of the app shows until the lock is known, and nothing while locked.
  if (lock.hash === undefined) return null;
  if (lock.locked) return <LockScreen onUnlock={unlock} waitUntil={lock.waitUntil} />;

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
        {!modelsNoticeOff && modelCheck?.missing.some((m) => m.tiers.length > 0) && (
          <div
            aria-label="Models notice"
            className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs"
          >
            <CircleAlert className="size-3.5 text-amber-600" />
            <span className="flex-1">
              A model a tier uses is no longer listed by its provider:{" "}
              {modelCheck.missing
                .filter((m) => m.tiers.length > 0)
                .map((m) => m.displayName)
                .join(", ")}
              .
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setModelsNoticeOff(true);
                setView("settings");
              }}
            >
              See models
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss models notice"
              onClick={() => {
                setModelsNoticeOff(true);
              }}
            >
              <X />
            </Button>
          </div>
        )}
        {!pricesNoticeOff && oldestPriceDays(catalog, at) > STALE_DAYS && (
          <div
            aria-label="Prices notice"
            className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs"
          >
            <CircleAlert className="size-3.5 text-amber-600" />
            <span className="flex-1">
              Some prices were last checked {oldestPriceDays(catalog, at)} days ago, so costs may be
              off.
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPricesNoticeOff(true);
                setView("settings");
              }}
            >
              Check prices
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss prices notice"
              onClick={() => {
                setPricesNoticeOff(true);
              }}
            >
              <X />
            </Button>
          </div>
        )}
        {alerts.map((a, i) => (
          <div
            key={`${String(i)}-${a}`}
            role="alert"
            className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs"
          >
            <CircleAlert className="size-3.5 text-amber-600" />
            <span className="flex-1">{a}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss alert"
              onClick={() => {
                setAlerts((all) => all.filter((_, j) => j !== i));
              }}
            >
              <X />
            </Button>
          </div>
        ))}
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
              onPin={togglePin}
              onArchive={toggleArchive}
              onSearch={() => {
                setSearchOpen(true);
              }}
              onUsage={openUsage}
            />
          )}
          {view === "usage" ? (
            <UsageScreen
              view={usageView}
              savings={savings}
              onSubscription={(usd) => {
                const micro = usd === null ? null : Math.round(usd * 1_000_000);
                setSetting(
                  db,
                  tenant,
                  "savings.subscription_micro",
                  micro === null ? "" : String(micro),
                )
                  .then(() => loadSavings(Date.now()))
                  .catch(report);
              }}
              onPeriod={setUsagePeriod}
              onBack={() => {
                setView("chat");
              }}
            />
          ) : view === "settings" ? (
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
              appLock={
                <AppLockSection
                  enabled={Boolean(lock.hash)}
                  idleMinutes={lock.idleMinutes}
                  minLength={MIN_LENGTH}
                  onSet={setPasscode}
                  onRemove={removePasscode}
                  onIdle={(minutes) => {
                    setLock((l) => ({ ...l, idleMinutes: minutes }));
                    setSetting(db, tenant, LOCK_IDLE, String(minutes)).catch(report);
                  }}
                />
              }
              importer={
                <ImportSection
                  sources={IMPORT_SOURCES}
                  onRead={async (source, file) => {
                    const bytes = new Uint8Array(await file.arrayBuffer());
                    const read = readExport(source, bytes, file.name);
                    pendingImport.current = { source: source as ImportSource, ...read };
                    return {
                      ...(await previewImport(db, tenant, source as ImportSource, read.chats)),
                      projects: read.projects.length,
                    };
                  }}
                  onImport={async (onProgress) => {
                    const pending = pendingImport.current;
                    if (!pending) return 0;
                    for (const p of pending.projects) await importProject(p);
                    const n = await writeImport(
                      db,
                      tenant,
                      pending.source,
                      pending.chats,
                      projectIdFor,
                      onProgress,
                    );
                    pendingImport.current = null;
                    await refreshThreads();
                    await refreshProjects();
                    return n;
                  }}
                >
                  <ImportPaste
                    current={globalInstructions ?? NO_INSTRUCTIONS}
                    onMemories={async (text) => {
                      const known = [...memories, ...proposals].map((m) => m.text);
                      const out = memoriesFromText(text, known);
                      await addProposals(db, tenant, out.proposals);
                      await refreshMemory();
                      if (out.proposals.length > 0) setReviewOpen(true);
                      const extra = [
                        out.duplicates > 0 ? `${String(out.duplicates)} already known` : "",
                        out.secrets > 0 ? `${String(out.secrets)} left out as secrets` : "",
                      ].filter(Boolean);
                      return `${String(out.proposals.length)} memories to review${extra.length ? ` (${extra.join(", ")})` : ""}.`;
                    }}
                    onInstructions={async (box, text) => {
                      const value = { ...(await getGlobalInstructions(db, tenant)) };
                      const now = value[box].trim();
                      value[box] = now ? `${now}\n\n${text.trim()}` : text.trim();
                      await setGlobalInstructions(db, tenant, value);
                      setGlobal(await getGlobalInstructions(db, tenant));
                    }}
                  />
                </ImportSection>
              }
              data={
                exporter && (
                  <DataSection
                    onExport={async () => {
                      const out = await exportAll(db, tenant, filesApi);
                      const day = new Date().toISOString().slice(0, 10);
                      const saved = await exporter.save(`fuse-export-${day}.zip`, out.bytes);
                      return saved
                        ? `Saved ${saved}: ${String(out.chats)} chats, ${String(out.files)} files.`
                        : null;
                    }}
                    onDeleteAll={async (removeKeys) => {
                      for (const c of controllers.current.values()) c.abort();
                      await deleteAllData(db, tenant, filesApi);
                      if (removeKeys) {
                        for (const k of keys.keys) {
                          if (k.saved) await keysApi.remove(k.provider);
                        }
                      }
                      try {
                        localStorage.removeItem(LAST_THREAD_KEY);
                      } catch {
                        // nothing remembered
                      }
                      onRestart();
                    }}
                  />
                )
              }
              quickCapture={
                quickCapture && (
                  <QuickCaptureSection
                    key={shortcut.shortcut ?? "off"}
                    shortcut={shortcut.shortcut}
                    mayNotWork={shortcut.mayNotWork}
                    error={shortcut.error}
                    onSave={(value) => {
                      void applyShortcut(value, true);
                    }}
                  />
                )
              }
              models={
                <ModelsSection
                  canCheck={savedProviders.length > 0}
                  check={
                    modelCheck
                      ? {
                          checked: new Date(modelCheck.checkedAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                          }),
                          found: modelCheck.found,
                          failed: modelCheck.failed,
                          missing: modelCheck.missing.map((m) => ({
                            ...m,
                            tiers: m.tiers.map(
                              (t) => policy.tiers.find((x) => x.id === t)?.label ?? t,
                            ),
                            replacement: m.replacement?.id ?? null,
                          })),
                        }
                      : null
                  }
                  custom={customModels.map((m) => ({ key: modelKey(m), name: m.displayName }))}
                  onCheck={checkModels}
                  onAdd={(form) => {
                    const model: CatalogModel = {
                      provider: form.provider,
                      id: form.id,
                      displayName: form.displayName,
                      contextWindow: form.contextWindow,
                      maxOutput: form.maxOutput,
                      price: { input: form.input, output: form.output },
                      capabilities: form.vision ? ["vision", "streaming"] : ["streaming"],
                      verifiedOn: new Date().toISOString().slice(0, 10),
                      sourceUrl: PRICING_PAGE[form.provider],
                      notes: "Added by hand in FUSE.",
                    };
                    const next = [
                      ...customModels.filter((m) => modelKey(m) !== modelKey(model)),
                      model,
                    ];
                    setCustomModels(next);
                    setModelCheck((c) =>
                      c
                        ? {
                            ...c,
                            found: c.found.filter(
                              (f) => `${f.provider}/${f.id}` !== modelKey(model),
                            ),
                          }
                        : c,
                    );
                    setSetting(db, tenant, CUSTOM_MODELS_SETTING, JSON.stringify(next)).catch(
                      report,
                    );
                  }}
                  onRemove={(key) => {
                    const next = customModels.filter((m) => modelKey(m) !== key);
                    setCustomModels(next);
                    setSetting(db, tenant, CUSTOM_MODELS_SETTING, JSON.stringify(next)).catch(
                      report,
                    );
                  }}
                />
              }
              prices={
                <PricesSection
                  rows={catalog.models.map((m) => ({
                    key: modelKey(m),
                    name: m.displayName,
                    ...m.price,
                    verifiedOn: m.verifiedOn,
                    edited: modelKey(m) in priceEdits,
                  }))}
                  version={catalog.priceVersion}
                  oldestDays={oldestPriceDays(catalog, at)}
                  staleDays={STALE_DAYS}
                  onSave={(key, price) => {
                    const next = Object.fromEntries(
                      Object.entries(priceEdits).filter(([k]) => k !== key),
                    );
                    if (price && price.input !== undefined && price.output !== undefined) {
                      next[key] = {
                        input: price.input,
                        output: price.output,
                        ...(price.cachedInput === undefined
                          ? {}
                          : { cachedInput: price.cachedInput }),
                        ...(price.cacheWrite === undefined ? {} : { cacheWrite: price.cacheWrite }),
                        editedOn: new Date().toISOString().slice(0, 10),
                      };
                    }
                    setPriceEdits(next);
                    setSetting(db, tenant, EDITS_SETTING, JSON.stringify(next)).catch(report);
                  }}
                  onCheck={async () => {
                    if (!web) throw new Error("Checking prices needs the desktop app.");
                    const page = await web.fetch(PRICES_URL);
                    const next = parseCatalog(JSON.parse(page.body));
                    const problems = checkPolicy(policy, next);
                    if (problems.length > 0) {
                      throw new Error(
                        `That price list doesn't fit the routing tiers: ${problems.join("; ")}`,
                      );
                    }
                    const current = baseCatalog(shippedCatalog, fetchedPrices);
                    checkedPrices.current = page.body;
                    return {
                      version: next.priceVersion,
                      changes:
                        next.priceVersion < current.priceVersion ? [] : diffPrices(current, next),
                    };
                  }}
                  onApply={async () => {
                    const body = checkedPrices.current;
                    if (!body) return;
                    await setSetting(db, tenant, FETCHED_SETTING, body);
                    setFetchedPrices(body);
                    setPricesNoticeOff(true);
                  }}
                />
              }
              budgets={
                <BudgetsSection
                  budgets={budgetViews}
                  projects={projects}
                  onAdd={(form) => {
                    addBudget(db, tenant, {
                      projectId: form.projectId,
                      period: form.period,
                      limitMicro: form.limitUsd * 1_000_000,
                      hardStop: form.hardStop,
                    })
                      .then(() => listBudgets(db, tenant))
                      .then(setBudgets)
                      .catch(report);
                  }}
                  onDelete={(id) => {
                    deleteBudget(db, tenant, id)
                      .then(() => listBudgets(db, tenant))
                      .then(setBudgets)
                      .catch(report);
                  }}
                />
              }
              routing={
                <>
                  <PolicyEditor
                    policy={globalPolicy}
                    isCustom={Boolean(savedPolicy)}
                    projects={projects}
                    projectRules={projectRules}
                    models={catalog.models.map((m) => ({
                      key: modelKey(m),
                      name: m.displayName,
                      provider: m.provider,
                      id: m.id,
                    }))}
                    problems={(draft) => checkPolicy(draft, catalog)}
                    score={(before, after) =>
                      golden && golden.length > 0 ? compareOnGoldenSet(before, after, golden) : null
                    }
                    onSave={(draft) => {
                      const raw = JSON.stringify(
                        serializePolicy({
                          ...draft,
                          policyVersion: new Date().toISOString().slice(0, 10),
                          builtFromPriceVersion: draft.builtFromPriceVersion,
                        }),
                      );
                      setSavedPolicy(raw);
                      setSetting(db, tenant, POLICY_SETTING, raw).catch(report);
                    }}
                    onSaveProject={(projectId, rules) => {
                      const all = Object.fromEntries(
                        Object.entries(projectRules).map(([id, rs]) => [
                          id,
                          rulesToRaw(globalPolicy, rs),
                        ]),
                      );
                      all[projectId] = rulesToRaw(globalPolicy, rules);
                      const raw = JSON.stringify(all);
                      setProjectRulesRaw(raw);
                      setSetting(db, tenant, PROJECT_RULES_SETTING, raw).catch(report);
                    }}
                    onReset={() => {
                      setSavedPolicy(null);
                      setSetting(db, tenant, POLICY_SETTING, "").catch(report);
                    }}
                    onImport={(text) => readPolicyFile(text, catalog)}
                    onExport={
                      exporter &&
                      ((draft) => {
                        const bytes = new TextEncoder().encode(
                          `${JSON.stringify(serializePolicy(draft), null, 2)}\n`,
                        );
                        exporter.save("fuse-routing.json", bytes).catch(report);
                      })
                    }
                  />
                  {golden && (
                    <GoldenSetSection
                      summary={summarize(golden)}
                      score={golden.length > 0 ? scoreGoldenSet(globalPolicy, golden) : null}
                      onImport={importGolden}
                    />
                  )}
                </>
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
              textSize={appearance.textSize}
              onTextSize={appearance.setTextSize}
              motion={appearance.motion}
              onMotion={appearance.setMotion}
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
                    <Tip
                      label={
                        cacheRate === null
                          ? "Total cost and tokens for this conversation"
                          : `Total cost and tokens for this conversation. ${String(Math.round(cacheRate * 100))}% of the input was read from the provider's cache, at a tenth of the price or less.`
                      }
                    >
                      <div
                        tabIndex={0}
                        aria-label="Thread total"
                        className="flex items-center gap-2 rounded-md px-1 py-1 font-mono text-[10px] text-muted-foreground"
                      >
                        <span className="text-foreground/80">{money(thread.costMicroUsd)}</span>
                        <span className="text-border">/</span>
                        <span>{number(threadTokens(messages))} tokens</span>
                        {cacheRate !== null && cacheRate > 0 && (
                          <>
                            <span className="text-border">/</span>
                            <span>{Math.round(cacheRate * 100)}% cached</span>
                          </>
                        )}
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
                        pinned={thread.pinnedAt !== null}
                        archived={thread.archivedAt !== null}
                        onTogglePin={() => {
                          togglePin({ id: thread.id, pinned: thread.pinnedAt !== null });
                        }}
                        onToggleArchive={() => {
                          toggleArchive({ id: thread.id, archived: thread.archivedAt !== null });
                        }}
                        onEditTags={() => {
                          setTagging(thread.id);
                        }}
                      />
                    )}
                  </>
                )}
              </header>
              <div className="flex min-h-0 flex-1">
                <div className="flex min-w-0 flex-1 flex-col">
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
                    openArtifact={openArtifact}
                    onOpenArtifact={showArtifact}
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
                      Incognito: this chat isn&apos;t saved or searchable and doesn&apos;t use or
                      add memories. It&apos;s deleted when you leave it.
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
                    {...(messages.length > 0
                      ? {
                          context: {
                            used: pathTokens(messages),
                            window: model.contextWindow,
                            summarizeAt: summaryThreshold(model),
                          },
                        }
                      : {})}
                    status={
                      trouble
                        ? `${PROVIDER_NAMES[trouble.provider]} had trouble at ${new Date(trouble.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: answers move to the other provider while it lasts.`
                        : null
                    }
                    routing={{
                      selected:
                        mode.kind === "auto" ? "auto" : mode.kind === "tier" ? mode.tier : null,
                      descriptions: {
                        auto: "Picks Balanced or Best for each message from what you ask",
                        balanced: tierDescription("balanced"),
                        best: tierDescription("best"),
                      },
                      preview: previewTier,
                      once: onceArmed || oneShot !== null,
                      onOnce: (on) => {
                        setOnceArmed(on);
                        if (!on) setOneShot(null);
                      },
                      onSelect: (choice) => {
                        chooseMode(choice === "auto" ? AUTO : { kind: "tier", tier: choice });
                      },
                    }}
                    onSend={(text, opts) => void send(text, opts?.thinkHarder)}
                    onStop={stop}
                    onSettings={() => {
                      setView("settings");
                    }}
                    attachments={pendingViews}
                    blocked={blocked}
                    onAddFiles={attachments.add}
                    onRemoveAttachment={attachments.remove}
                    onAttachmentMode={attachments.setMode}
                    {...(web ? { onAddLink: attachments.addLink } : {})}
                    webSearch={model.capabilities.includes("web_search") ? searchOn : null}
                    onToggleWebSearch={toggleSearch}
                  />
                </div>
                {panelArtifact && (
                  <ArtifactPanel
                    key={panelArtifact.key}
                    artifact={panelArtifact}
                    {...(preview ? { preview } : {})}
                    {...(openSaved
                      ? {
                          onAllowCdn: (allow: boolean) => {
                            const id = openSaved.id;
                            setArtifactCdn(db, tenant, id, allow)
                              .then(() => {
                                setThreadArtifacts((all) =>
                                  all.map((a) => (a.id === id ? { ...a, allowCdn: allow } : a)),
                                );
                              })
                              .catch(report);
                          },
                        }
                      : {})}
                    {...(exporter
                      ? {
                          onExport: async (format: "file" | "docx" | "pdf") => {
                            const a = panelArtifact;
                            const name = (ext: string) => fileName(a.title, ext);
                            if (format === "docx") {
                              return exporter.save(name("docx"), markdownToDocx(a.content));
                            }
                            if (format === "pdf") {
                              return exporter.save(
                                name("pdf"),
                                await markdownToPdf(a.content, a.title),
                              );
                            }
                            return exporter.save(
                              name(extensionFor(a.type, a.language)),
                              new TextEncoder().encode(a.content),
                            );
                          },
                        }
                      : {})}
                    onClose={() => {
                      showArtifact(null);
                    }}
                    versions={{
                      versions: versions.map((v) => ({
                        version: v.version,
                        by: v.source === "model" ? "AI" : v.source === "user" ? "You" : "Restored",
                        when: new Date(v.createdAt).toLocaleString([], {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        }),
                      })),
                      shown: shownVersion,
                      compareWith,
                      diff: artifactDiff,
                      onShow: (v) => {
                        setShownVersion(v);
                        setCompareWith(null);
                      },
                      onCompare: setCompareWith,
                      onRestore: (v) => {
                        const old = versions.find((x) => x.version === v);
                        if (old) newVersion(old.content, "restore");
                      },
                      onSaveEdit: (content) => {
                        newVersion(content, "user");
                      },
                      onAskEdit: (selection, instruction) => {
                        if (!openSaved || streaming) return;
                        editFrom.current = { key: openSaved.key, version: openSaved.version };
                        void send(artifactEditRequest(openSaved, selection, instruction));
                      },
                    }}
                  />
                )}
              </div>
            </main>
          )}
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} items={paletteItems} />
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
                  defaultTier: editedProject.defaultTier,
                }
              : null
          }
          models={options}
          maxChars={MAX_INSTRUCTION_CHARS}
          onSave={saveProject}
          {...(editedProject ? { onDelete: removeProject } : {})}
          {...(editedProject && knowledge?.projectId === editedProject.id
            ? {
                knowledge: {
                  files: knowledgeViews,
                  busy: knowledge.busy,
                  error: knowledge.error,
                  onAdd: (list: File[]) => {
                    addKnowledge(editedProject.id, list);
                  },
                  onRemove: (fileId: string) => {
                    const projectId = editedProject.id;
                    removeProjectFile(db, tenant, projectId, fileId)
                      .then(() => listProjectFiles(db, tenant, projectId))
                      .then((files) => {
                        setKnowledge((k) => (k ? { ...k, files } : k));
                      })
                      .catch(report);
                  },
                },
              }
            : {})}
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
        {taggingThread && (
          <TagsDialog
            open
            tags={taggingThread.tags}
            known={[...new Set(threads.flatMap((t) => t.tags))].sort()}
            onOpenChange={(open) => {
              if (!open) setTagging(null);
            }}
            onSave={(tags) => {
              setTagging(null);
              setThreadTags(db, tenant, taggingThread.id, tags).then(refreshThreads).catch(report);
            }}
          />
        )}
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
          open={bigAsk !== null}
          onOpenChange={(open) => {
            if (!open) setBigAsk(null);
          }}
          title="A big message"
          description={
            bigAsk
              ? `This adds about ${number(bigAsk.added)} tokens. On ${bigAsk.model} the message would cost about ${money(bigAsk.micro)} to read, and the files are sent again with every later message in this chat.`
              : ""
          }
        >
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setBigAsk(null);
              }}
            >
              Cancel
            </Button>
            {bigAsk && bigAsk.files > 0 && bigAsk.text.trim() && (
              <Button
                variant="outline"
                onClick={() => {
                  const ask = bigAsk;
                  setBigAsk(null);
                  void send(ask.text, ask.thinkHarder, {
                    over: ask.overConfirmed,
                    dropFiles: true,
                  });
                }}
              >
                Send without the files
              </Button>
            )}
            <Button
              onClick={() => {
                const ask = bigAsk;
                setBigAsk(null);
                if (ask)
                  void send(ask.text, ask.thinkHarder, { over: ask.overConfirmed, big: true });
              }}
            >
              Send
            </Button>
          </div>
        </Modal>
        <Modal
          open={overAsk !== null}
          onOpenChange={(open) => {
            if (!open) setOverAsk(null);
          }}
          title="Over budget"
          description={
            overAsk
              ? `${budgetName(overAsk.state.budget)}: ${money(overAsk.state.spent)} of ${money(overAsk.state.budget.limitMicro)} this ${overAsk.state.budget.period}.${overAsk.state.budget.hardStop ? " This budget has a hard stop." : ""}`
              : ""
          }
        >
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setOverAsk(null);
              }}
            >
              Don&apos;t send
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const ask = overAsk;
                setOverAsk(null);
                if (!ask) return;
                const b = ask.state.budget;
                allowBudgetUntil(db, tenant, b.id, periodEnd(b.period, Date.now()))
                  .then(() => listBudgets(db, tenant))
                  .then(async (list) => {
                    setBudgets(list);
                    await send(ask.text, ask.thinkHarder, { over: true });
                  })
                  .catch(report);
              }}
            >
              Allow for the rest of this {overAsk?.state.budget.period ?? "period"}
            </Button>
            {!overAsk?.state.budget.hardStop && (
              <Button
                onClick={() => {
                  const ask = overAsk;
                  setOverAsk(null);
                  if (ask) void send(ask.text, ask.thinkHarder, { over: true });
                }}
              >
                Send anyway
              </Button>
            )}
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
