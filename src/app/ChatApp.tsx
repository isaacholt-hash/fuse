// The chat screen: Astra's presentational components (src/ui) wired to storage, keys and the chat
// engine. All state that matters lives in SQLite; this holds only what's on screen.
import { allowNetwork, disallowNetwork, networkFolders } from "@/storage/network";
import { projectToolsOff, switchProjectTool } from "@/storage/projectTools";
import { KIND_LABEL, placesLabel, TOOLS } from "@/agent/registry";
import { resolvePath } from "@/agent/folders";
import { docKind, docxText, xlsxText } from "@/documents/read";
import { getChange, listRunFolders } from "@/storage/runs";
import {
  recordShadow,
  shadowSummary,
  type ShadowRecord,
  type ShadowSummary,
} from "@/storage/localShadow";
import type { LocalApi } from "@/local/api";
import { gb, pickProfile, type Hardware } from "@/local/hardware";
import { statusFor, usableProfile, type InstalledFile } from "@/local/install";
import { localCatalogModel, localModels, type LocalProfile } from "@/local/models";
import { LocalModelSection, type LocalModelView } from "@/ui/LocalModel";
import { PythonRuntimeSection } from "@/ui/PythonRuntime";
import { McpServersSection, type McpServerDraft, type McpServerView } from "@/ui/McpServers";
import { joinCommand, splitCommand, type McpApi } from "@/mcp/api";
import {
  addMcpServer,
  listMcpServers,
  listProjectMcpServers,
  removeMcpServer,
  setMcpServerNetwork,
  setProjectMcpServer,
} from "@/storage/mcp";
import {
  pythonPin,
  thisPlatform,
  type PythonApi,
  type PythonMsg,
  type PythonRuntime,
} from "@/python/runtime";
import { CircleAlert, EyeOff, Folder, PanelLeft, Pencil, Sparkles, X } from "lucide-react";
import { Tooltip } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { WebFolderDialog } from "@/ui/WebFolder";
import { WEB_REASONS } from "@/ui/webReasons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  findModel,
  parseCatalog,
  priceFor,
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
import type { RepoApi, RepoInfo } from "@/repo/api";
import { WINDOWS_SANDBOX_SETTING, type ExecApi } from "@/repo/exec";
import type { GitApi } from "@/repo/git";
import type { RepoInstruction } from "@/repo/instructions";
import { instructionsIn } from "@/agent/folders";
import {
  folderName,
  grantFolder,
  linkProjectFolder,
  linkThreadFolder,
  listProjectFolders,
  listThreadFolders,
  unlinkProjectFolder,
  unlinkThreadFolder,
  type Folder as FolderRecord,
} from "@/storage/folders";
import { continueChatRun, startChatRun } from "@/agent/chatRun";
import {
  DEFAULT_RUN_CAP_MICRO_USD,
  undoChange,
  undoRun,
  type ApprovalAnswer,
  type ApprovalRequest,
  type RunProgress,
} from "@/agent/run";
import type { RunMode } from "@/storage/runs";
import {
  getRun,
  listChanges,
  listSteps,
  recentRuns,
  recentToolCalls,
  runStatesForThread,
  runsEndedSince,
  runsForThread,
  type AuditEntry,
  type RecentRun,
} from "@/storage/runs";
import {
  answerApproval,
  askToContinue,
  askToStart,
  askToStop,
  getLive,
  getRequest,
  openApprovals,
  type StartInput,
} from "@/storage/runQueue";
import { RunsScreen, type RunListRow } from "@/ui/Runs";
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  setScheduleEnabled,
  updateSchedule,
  type Schedule,
} from "@/storage/schedules";
import { ScheduledTasksSection, type ScheduleDefaults } from "@/ui/Schedules";
import { AgentAuditSection } from "@/ui/AgentAudit";
import { approvalView, auditCsv, auditJson, auditRow, runView } from "./runView";
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
  sendWithoutModel,
  type ChatDeps,
} from "@/chat/sendMessage";
import { housekeepingModel } from "@/chat/housekeeping";
import { classify, type Classification } from "@/routing/classify";
import { checkClassification } from "@/routing/classifyFallback";
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
import {
  citationsForMessages,
  fileCitationsForMessages,
  type Citation,
  type FileSource,
} from "@/storage/citations";
import { getFile } from "@/storage/files";
import { getChunk } from "@/storage/vectors";
import { FileViewer, type FileViewerView } from "@/ui/FileViewer";
import { describeSecrets } from "@/files/fileSecrets";
import { filesForMessages, type FileRecord } from "@/storage/files";
import {
  getGlobalInstructions,
  NO_INSTRUCTIONS,
  setGlobalInstructions,
  type GlobalInstructions,
} from "@/storage/instructions";
import {
  addDecision,
  addMemory,
  addProposals,
  approveProposal,
  conflictWith,
  deleteAllMemories,
  deleteMemory,
  editDecision,
  editMemory,
  listDecisions,
  listMemories,
  listTasks,
  setMemoryExcluded,
  addTask,
  blockedBy,
  renameTask,
  setTaskDependsOn,
  setTaskStatus,
  listMemoryRecords,
  listPendingProposals,
  listReplaced,
  memoriesForMessages,
  rejectProposal,
  restoreMemory,
  type ReplacedMemory,
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
  setProjectPrivacy,
  setProjectAnswerWithoutModel,
  setProjectRunMode,
  disallowCommand,
  listAllowedCommands,
  type Project,
} from "@/storage/projects";
import { listRecentRequests, logRequest, medianFirstTokenMs } from "@/storage/requestLog";
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
  setThreadStay,
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
  DISMISSED_SETTING,
  OVERRIDES_SETTING,
  parseJsonList,
  suggestRules,
  withOverride,
  type Override,
} from "@/routing/learn";
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
import { KIND_LABELS } from "@/ui/memoryLabels";
import { ProjectDialog, type KnowledgeFileView } from "@/ui/Projects";
import { ArtifactPanel, type ArtifactView } from "@/ui/Artifacts";
import {
  addVersion,
  listArtifacts,
  listVersions,
  type Artifact,
  type ArtifactVersion,
  setArtifactCdn,
  projectArtifacts,
  searchArtifacts,
  type ArtifactHit,
} from "@/storage/artifacts";
import { diffLines } from "@/artifacts/diff";
import { artifactsIn, splitAnswer } from "@/artifacts/parse";
import {
  addProjectFile,
  listProjectFiles,
  removeProjectFile,
  type ProjectFile,
} from "@/storage/projectFiles";
import { syncFolderKnowledge } from "@/knowledge/folderSync";
import { ensureIndexed } from "@/knowledge/retrieve";
import { prepareDocument } from "@/files/documents";
import { addFile } from "@/storage/files";
import { SearchDialog, type SearchHitView } from "@/ui/Search";
import { CommandPalette, type PaletteItem } from "@/ui/Palette";
import { QuickCaptureSection } from "@/ui/QuickCapture";
import { DataSection } from "@/ui/DataSection";
import type { DecisionInputView, DecisionView } from "@/ui/Decisions";
import type { TaskStatusView, TaskView } from "@/ui/Tasks";
import type { PrivacyModeView } from "@/ui/ProjectPrivacy";
import { PrivacySection } from "@/ui/PrivacySection";
import { WindowsSandboxSection } from "@/ui/WindowsSandbox";
import type { BackupsApi } from "@/data/backups";
import { allowedEmbedding, egressRefusal, policyFor, projectPolicy } from "@/context/egress";
import { listEgressRules, setEgressRule, setFileMaySend, type EgressRule } from "@/storage/egress";
import { ImportPaste } from "@/ui/ImportPaste";
import { ModelsSection } from "@/ui/Models";
import { PricesSection } from "@/ui/Prices";
import { ImportSection, type ImportSourceView } from "@/ui/ImportSection";
import { previewImport, writeImport, type ImportedChat, type ImportSource } from "@/import/write";
import { readChatGptExport } from "@/import/chatgpt";
import { readClaudeExport, type ImportedProject } from "@/import/claude";
import { AppLockSection, LockScreen } from "@/ui/AppLock";
import { hashPasscode, lockoutSeconds, MIN_LENGTH, verifyPasscode } from "@/security/passcode";
import { exportAll, exportData, exportName } from "@/data/exportAll";
import {
  applyRestore,
  onlyProject,
  planRestore,
  readFuseExport,
  restoreLines,
  type ParsedExport,
} from "@/data/restore";
import { deleteAllData } from "@/data/deleteAll";
import { DEFAULT_SHORTCUT, SHORTCUT_SETTING, type QuickCaptureApi } from "./quickCapture";
import { useAppearance, type ZoomApi } from "./appearance";
import { HELLO_SETTING, type HelloApi } from "@/security/hello";
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
  spentByProvider,
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
import {
  UsageScreen,
  type EconomicsView,
  type SavingsView,
  type UsagePeriod,
  type UsageScreenView,
} from "@/ui/Usage";
import {
  bestExtraSince,
  cacheTokensSince,
  cloudCallsAvoidedSince,
  listQuestionTasks,
  listUsage,
  type UsageRecord,
} from "@/storage/usageReport";
import { cacheSavings } from "@/cost/savings";
import { answerWithoutModel } from "@/deterministic/handlers";
import { againstBaseline, economics as taskEconomics, parseBaseline } from "@/cost/economics";
import { getSetting, setSetting } from "@/storage/settings";
import { PERIOD_DAYS, usageReport, type Dimension } from "@/cost/report";
import { INTENT_LABELS } from "@/routing/classify";
import { Sidebar } from "@/ui/Sidebar";
import { TagsDialog } from "@/ui/Tags";
import { KeyCapsSection } from "@/ui/KeyCaps";
import {
  CAPS_SETTING,
  capState,
  localDay,
  parseCaps,
  parseRaises,
  RAISED_SETTING,
  type CapRaises,
  type KeyCaps,
} from "@/cost/keyCaps";
import { ModelDefaultsSection } from "@/ui/ModelDefaults";
import {
  DEFAULTS_SETTING,
  modelDefaultsKey,
  parseDefaults,
  projectKey,
  resolveDefaults,
  tierKey,
  type DefaultsMap,
} from "@/routing/modelDefaults";
import { chatMarkdown } from "@/data/exportAll";
import { threadJson, type ThreadExportFormat } from "@/data/exportThread";
import { FillPromptDialog, PromptsSection } from "@/ui/Prompts";
import {
  deletePrompt,
  fillPrompt,
  listPrompts,
  promptVariables,
  savePrompt,
  type SavedPrompt,
} from "@/storage/prompts";
import { SideBySide } from "@/ui/SideBySide";
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
  /** The coding agent's linked repository (CA-01). */
  repoApi?: RepoApi;
  /** Commands in that repository (CA-03). */
  execApi?: ExecApi;
  /** git and gh there (CA-05). */
  gitApi?: GitApi;
  /** Backup and restore of the database (PL-11). */
  backups?: BackupsApi;
  /** The local model (M7): what this computer can run. */
  localApi?: LocalApi;
  /** M9 step 5: the Python runtime for data work. */
  pythonApi?: PythonApi;
  /** M9 step 8: MCP servers' keychain values. */
  mcpApi?: McpApi;
  /** The global quick-capture shortcut (CH-08, PL-07). */
  quickCapture?: QuickCaptureApi;
  zoom?: ZoomApi;
  hello?: HelloApi;
  /** Starts the app over (after delete-all); a page reload by default. */
  onRestart?: () => void;
  /**
   * M10 step 5: this is the web app on HULK (`!isDesktop()`). Desktop-only features are greyed
   * with their reason (PL-02), and folders are typed in rather than picked in a native dialog.
   */
  webApp?: boolean;
  /** Settings → FUSE on HULK: the server's version, devices and Sign out (web app only). */
  server?: ReactNode;
}

const LAST_THREAD_KEY = "fuse.lastThread";

/** M10 step 6: how often the web app reads the runner's progress, questions and requests. */
const WEB_POLL_MS = 1000;
/** M10 step 8: when the Runs list was last opened; runs that ended since then are new. */
const RUNS_SEEN_KEY = "fuse.runsSeenAt";

function readRunsSeen(): number {
  try {
    return Number(localStorage.getItem(RUNS_SEEN_KEY) ?? "0") || 0;
  } catch {
    return 0;
  }
}

function saveRunsSeen(at: number): void {
  try {
    localStorage.setItem(RUNS_SEEN_KEY, String(at));
  } catch {
    // the badge just counts from the last time it could be remembered
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** A row of the Runs list: "waiting" when it has a question no one has answered. */
function runListRow(r: RecentRun, waiting: boolean): RunListRow {
  return {
    id: r.id,
    task: r.task,
    chat: r.threadTitle,
    threadId: r.threadTitle === null ? null : r.threadId,
    status: waiting
      ? "waiting"
      : r.status === "running"
        ? "going"
        : r.status === "error"
          ? "failed"
          : r.status,
    note: r.note,
    when: new Date(r.updatedAt).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }),
  };
}

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

/** AR-06: a few words of an artifact around the first search word, marked like chat hits. */
const artifactSnippet = (content: string, query: string) => {
  const word = query.match(/[\p{L}\p{N}_]+/u)?.[0] ?? "";
  const at = word ? content.toLowerCase().indexOf(word.toLowerCase()) : -1;
  if (at < 0) return content.slice(0, 120);
  const start = Math.max(0, at - 50);
  return `${start > 0 ? "…" : ""}${content.slice(start, at)}\u0001${content.slice(at, at + word.length)}\u0002${content.slice(at + word.length, at + word.length + 70)}…`;
};

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

/** LL-09: shadow checks run for this long after install, on this share of local jobs. */
const SHADOW_DAYS = 7;
const SHADOW_RATE = 0.1;

/** Where an install of the recommended profile is up to (LL-03). */
interface LocalJob {
  status: "downloading" | "verifying";
  progress: { done: number; total: number } | null;
}

/** Settings → Local model (LL-03): this computer, the profile it gets, and its install. */
function localModelView(
  hw: Hardware | null,
  installed: readonly InstalledFile[],
  job: LocalJob | null,
  installError: string | null,
): LocalModelView | null {
  if (!hw) return null;
  const choice = pickProfile(hw, localModels.profiles);
  const p = choice.profile;
  const others = installed
    .filter((f) => f.file !== p?.file)
    .map((f) => ({
      file: f.file,
      label: `${localModels.profiles.find((x) => x.file === f.file)?.displayName ?? f.file} (${gb(f.sizeBytes)})`,
    }));
  return {
    others,
    ...(p
      ? {
          install: {
            status: job?.status ?? statusFor(p, installed).kind,
            progress: job?.progress ?? null,
            error: installError,
          },
        }
      : {}),
    computer: [
      `${gb(hw.totalMemoryBytes)} memory (${gb(hw.availableMemoryBytes)} free)`,
      `${String(hw.logicalCpus)} CPUs`,
      hw.cpuSupported ? "AVX2" : "no AVX2",
      hw.freeDiskBytes === null ? "free disk unknown" : `${gb(hw.freeDiskBytes)} free disk`,
    ].join(" · "),
    reason: choice.reason,
    warning: choice.warning,
    profile: p
      ? {
          name: p.displayName,
          file: p.file,
          detail: `${p.quantization} · ${gb(p.sizeBytes)} download · about ${gb(p.peakMemoryBytes)} of memory`,
          licence: p.licence,
          licenceUrl: p.licenceUrl,
          sourceUrl: p.sourceUrl,
        }
      : null,
  };
}

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
  repoApi,
  execApi,
  gitApi,
  backups,
  localApi,
  pythonApi,
  mcpApi,
  quickCapture,
  zoom,
  hello,
  onRestart = () => {
    window.location.reload();
  },
  webApp = false,
  server,
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
  const [threadFileSources, setThreadFileSources] = useState<Map<string, FileSource[]>>(new Map());
  // FK-10: a file open in the side panel, at the place an answer cited.
  const [viewer, setViewer] = useState<FileViewerView | null>(null);
  // Memories sent with the answers on screen, by message id.
  const [threadMemories, setThreadMemories] = useState<
    Awaited<ReturnType<typeof memoriesForMessages>>
  >(new Map());
  // Memory (step 7): saved facts, suggestions waiting, and what the last check skipped as secrets.
  // MM-04: a newer fetched price list and your own edits, on top of the shipped catalog.
  const [fetchedPrices, setFetchedPrices] = useState<string | null>(null);
  const [priceEdits, setPriceEdits] = useState<PriceEdits>({});
  const [pricesNoticeOff, setPricesNoticeOff] = useState(false);
  // MM-03/MM-08: models you added, and the last read of the providers' model lists.
  const [customModels, setCustomModels] = useState<CatalogModel[]>([]);
  const [modelCheck, setModelCheck] = useState<ModelCheck | null | undefined>(undefined);
  const [modelsNoticeOff, setModelsNoticeOff] = useState(false);
  // AR-06: the artifacts of the project whose settings are open.
  const [projectArts, setProjectArts] = useState<ArtifactHit[]>([]);
  // PM-15: the open project's decisions, in force and replaced.
  const [projectDecisions, setProjectDecisions] = useState<Memory[]>([]);
  // PM-16: the open project's tasks.
  const [projectTasks, setProjectTasks] = useState<Memory[]>([]);
  // MM-09: spend caps per key, days they were raised for, and what each key spent.
  const [caps, setCaps] = useState<KeyCaps>({});
  const [raises, setRaises] = useState<CapRaises>({});
  const [keySpend, setKeySpend] = useState<{
    day: Record<string, number>;
    month: Record<string, number>;
  }>({ day: {}, month: {} });
  // MM-07: your defaults per tier, model and project.
  const [modelDefaults, setModelDefaults] = useState<DefaultsMap>({});
  // CH-12: the prompt library, and a prompt waiting for its {{variables}}.
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [filling, setFilling] = useState<SavedPrompt | null>(null);
  // RT-12: models the next message goes to in compare mode; CH-17: answers shown side by side.
  const [compareKeys, setCompareKeys] = useState<string[]>([]);
  const [sideBySide, setSideBySide] = useState<string | null>(null);
  // RT-11: answers you moved up a tier, and suggestions you dismissed.
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<string[]>([]);
  const [suggestionNoticeOff, setSuggestionNoticeOff] = useState(false);
  // RT-06: each model's median time to first token this week, for price ties.
  const [latency, setLatency] = useState<Record<string, number>>({});
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
  // Settings → Memory also lists excluded and expired records (PM-14).
  const [memoryRecords, setMemoryRecords] = useState<Memory[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [replaced, setReplaced] = useState<ReplacedMemory[]>([]);
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
  const [economicsView, setEconomicsView] = useState<EconomicsView | null>(null);
  const [localHardware, setLocalHardware] = useState<Hardware | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localInstalled, setLocalInstalled] = useState<InstalledFile[]>([]);
  const [localJob, setLocalJob] = useState<LocalJob | null>(null);
  // M9 step 5: the Python runtime, its install under way, and why the last one failed.
  const [pyRuntime, setPyRuntime] = useState<PythonRuntime | null>(null);
  const [pyJob, setPyJob] = useState<{
    step: "downloading" | "verifying" | "unpacking" | "libraries";
    percent: number | null;
  } | null>(null);
  const [pyError, setPyError] = useState<string | null>(null);
  // M9 step 8: MCP servers, as Settings shows them.
  const [mcpServers, setMcpServers] = useState<McpServerView[]>([]);
  const [mcpHealth, setMcpHealth] = useState<Record<string, McpServerView["health"]>>({});
  const refreshMcp = async () => {
    const list = await listMcpServers(db, tenant);
    setMcpServers(
      await Promise.all(
        list.map(async (s) => {
          const set = mcpApi
            ? await mcpApi.secretStatus(s.id, s.envNames).catch(() => s.envNames.map(() => false))
            : s.envNames.map(() => false);
          const signedIn =
            s.transport === "http" && mcpApi?.signedIn
              ? await mcpApi.signedIn(s.id).catch(() => false)
              : undefined;
          return {
            id: s.id,
            name: s.name,
            ...(signedIn !== undefined ? { signedIn } : {}),
            detail:
              s.transport === "stdio"
                ? `Local: ${joinCommand(s.command ?? "", s.args)}`
                : `Remote: ${s.url ?? ""}`,
            local: s.transport === "stdio",
            network: s.network,
            variables: s.envNames.map((name, i) => ({ name, set: set[i] ?? false })),
          };
        }),
      ),
    );
  };
  /** M9 step 8: adds a server, its variables' values going to the keychain. */
  const addMcp = async (d: McpServerDraft): Promise<string | null> => {
    const parsed = d.transport === "stdio" ? splitCommand(d.commandLine) : null;
    if (parsed && "error" in parsed) return parsed.error;
    const vars = d.variables.filter((v) => v.name.trim());
    try {
      const server = await addMcpServer(db, tenant, {
        name: d.name,
        transport: d.transport,
        command: parsed?.command ?? null,
        args: parsed?.args ?? [],
        url: d.transport === "http" ? d.url : null,
        envNames: vars.map((v) => v.name.trim()),
        network: d.transport === "stdio" && d.network,
      });
      for (const v of vars) {
        if (v.value) await mcpApi?.setSecret(server.id, v.name.trim(), v.value);
      }
      await refreshMcp();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const [localInstallError, setLocalInstallError] = useState<string | null>(null);
  const refreshLocalInstalled = () => localApi?.installed().then(setLocalInstalled, report);
  /** LL-04: one switch for the local model; on unless turned off (Isaac, 2026-10-30). */
  const [localOn, setLocalOn] = useState(true);
  const usableLocal = usableProfile(localInstalled, localModels.profiles);
  const localHelper = useMemo(
    () => (localOn && usableLocal ? localCatalogModel(usableLocal, localModels.verifiedOn) : null),
    [localOn, usableLocal],
  );
  /** LL-09: in the week after install, about 1 in 10 local jobs is also run on the cloud. */
  const shadowRate = (() => {
    const file = usableLocal && localInstalled.find((f) => f.file === usableLocal.file);
    return file && Date.now() - file.installedMs < SHADOW_DAYS * 86_400_000 ? SHADOW_RATE : 0;
  })();
  const [shadow, setShadow] = useState<ShadowSummary | null>(null);
  useEffect(() => {
    getSetting(db, tenant, "local.enabled").then((v) => {
      setLocalOn(v !== "off");
    }, report);
    localApi?.installed().then(setLocalInstalled, () => undefined);
    pythonApi?.status().then(setPyRuntime, () => undefined);
    refreshMcp().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once at start
  }, [db, tenant]);
  /** M9 step 5: downloads, checks and installs the pinned Python and its libraries. */
  const installPython = () => {
    const pin = pythonPin(thisPlatform());
    if (!pythonApi || !pin) return;
    setPyError(null);
    setPyJob({ step: "downloading", percent: null });
    pythonApi
      .install(pin, (m: PythonMsg) => {
        if (m.kind === "progress") {
          setPyJob({
            step: "downloading",
            percent: Math.floor((m.done / Math.max(1, m.total)) * 100),
          });
        } else if (m.kind !== "done") {
          setPyJob({ step: m.kind, percent: null });
        }
      })
      .then(
        (r) => {
          setPyJob(null);
          setPyRuntime(r);
        },
        (e: unknown) => {
          setPyJob(null);
          setPyError(String(e));
        },
      );
  };
  /** LL-03: downloads, checks and installs the profile this computer gets. */
  const installLocal = (profile: LocalProfile) => {
    if (!localApi) return;
    setLocalInstallError(null);
    setLocalJob({ status: "downloading", progress: null });
    localApi
      .install(profile, (m) => {
        if (m.kind === "progress") {
          setLocalJob({ status: "downloading", progress: { done: m.done, total: m.total } });
        } else if (m.kind === "verifying") {
          setLocalJob((j) => ({ status: "verifying", progress: j?.progress ?? null }));
        }
      })
      .then(
        () => {
          setLocalJob(null);
          void refreshLocalInstalled();
        },
        (e: unknown) => {
          setLocalJob(null);
          setLocalInstallError(String(e));
          void refreshLocalInstalled();
        },
      );
  };
  // SE-03: the app lock. `hash` is the stored passcode hash (null = off, undefined = loading).
  const [lock, setLock] = useState<{
    hash: string | null | undefined;
    idleMinutes: number;
    locked: boolean;
    wrongTries: number;
    waitUntil: number;
    /** SE-03: Windows Hello is set up on this PC, and you chose to use it. */
    helloAvailable: boolean;
    helloOn: boolean;
  }>({
    helloAvailable: false,
    helloOn: false,
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
  // F6: a mode just picked for a saved chat, used until the chat list has reloaded with it. Without
  // this, a message sent before the pin was saved and read back went out on the old mode.
  const [pickedMode, setPickedMode] = useState<{ threadId: string; mode: RouteMode } | null>(null);
  const [view, setView] = useState<"chat" | "settings" | "usage" | "runs">(
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
    () => ({
      db,
      tenant,
      catalog,
      adapterFor,
      files,
      // LL-04: housekeeping tries the local model first when it's installed and on.
      local: localHelper,
      ...(shadowRate > 0
        ? { shadow: { rate: shadowRate, record: (r: ShadowRecord) => recordShadow(db, tenant, r) } }
        : {}),
      ...(repoApi ? { repo: repoApi } : {}),
      // M9 step 2: chats and runs read web pages with fetch_url.
      ...(web ? { web } : {}),
      // M9 step 9: a project's MCP servers' tools.
      ...(mcpApi?.tools && mcpApi.call
        ? {
            mcp: {
              forProject: (pid: string) =>
                listProjectMcpServers(db, tenant, pid).then((l) =>
                  l.map((s) => ({ id: s.id, name: s.name })),
                ),
              tools: (id: string) => mcpApi.tools?.(id) ?? Promise.resolve([]),
              call: (id: string, name: string, args: Record<string, unknown>) =>
                mcpApi.call
                  ? mcpApi.call(id, name, args)
                  : Promise.reject(new Error("MCP calls aren't available here.")),
            },
          }
        : {}),
    }),
    [db, tenant, catalog, adapterFor, files, repoApi, localHelper, shadowRate, web, mcpApi],
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
  // M8 step 9: the Windows sandbox, off until switched on; null where there's none to offer.
  const [windowsSandbox, setWindowsSandbox] = useState<{ on: boolean } | null>(null);
  useEffect(() => {
    const api = execApi?.windowsSandbox;
    if (!api) return;
    void (async () => {
      // Can't tell (no Tauri, as in tests): nothing to offer.
      if (!(await api.available().catch(() => false))) return;
      // On unless switched off (M8: on by default since it passed on Isaac's PC).
      const on = (await getSetting(db, tenant, WINDOWS_SANDBOX_SETTING)) !== "off";
      await api.set(on);
      setWindowsSandbox({ on });
    })().catch(report);
  }, [db, tenant, execApi]);
  // SE-13: provider rules, global and per project (privacy modes live on the project).
  const [egressRules, setEgressRules] = useState<EgressRule[]>([]);
  // CA-01: a line under the linked folder (git or not, or why linking failed).
  const [repoNote, setRepoNote] = useState<string | null>(null);
  /** WF-02: each project's folders, and each chat's own ("draft" before it's saved). */
  const [projectFolderMap, setProjectFolderMap] = useState<Record<string, FolderRecord[]>>({});
  const [chatFolderMap, setChatFolderMap] = useState<Record<string, FolderRecord[]>>({});
  const loadProjectFolders = (projectId: string) =>
    listProjectFolders(db, tenant, projectId).then(async (fs) => {
      setProjectFolderMap((m) => ({ ...m, [projectId]: fs }));
      setNetFolders(await networkFolders(db, tenant));
    });
  /** WF-07: folders whose sandboxed commands may use the network. */
  const [netFolders, setNetFolders] = useState<Set<string>>(new Set());
  const loadChatFolders = (threadId: string) =>
    listThreadFolders(db, tenant, threadId).then((fs) => {
      setChatFolderMap((m) => ({ ...m, [threadId]: fs }));
    });
  // M6: Code on per chat ("draft" before the chat exists), and each answer's coding run.
  /** M6 / WF-01: per chat, the next message starts a Code or a Work run (or neither). */
  const [codeOn, setCodeOn] = useState<Record<string, "code" | "work" | false>>({});
  // CA-03: commands waiting for your OK, by run.
  const [approvals, setApprovals] = useState<
    Map<string, { request: ApprovalRequest; answer: (a: ApprovalAnswer) => void }>
  >(new Map());
  // CA-04: what a run may do, per chat ("draft" before it exists); the project's mode otherwise.
  const [codeMode, setCodeMode] = useState<Record<string, RunMode>>({});
  // CA-05: start runs on a branch of their own, per chat.
  const [codeBranch, setCodeBranch] = useState<Record<string, boolean>>({});
  // AG-04: recent coding-run tool calls, for Settings.
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  // CA-04: commands the edited project always allows, for its settings.
  const [allowedCommands, setAllowedCommands] = useState<string[]>([]);
  // M9 step 1: tools the edited project switched off, for its settings.
  const [toolsOff, setToolsOff] = useState<Set<string>>(new Set());
  // M9 step 9: the MCP servers the edited project uses.
  const [projectServers, setProjectServers] = useState<Set<string>>(new Set());
  const [threadRuns, setThreadRuns] = useState<Map<string, RunProgress>>(new Map());
  // CA-06: the open chat's project's CLAUDE.md and AGENTS.md, for the instructions view.
  const [repoFiles, setRepoFiles] = useState<{ projectId: string; files: RepoInstruction[] }>({
    projectId: "",
    files: [],
  });
  // PL-12: the export being restored, between its preview and the yes.
  const restoring = useRef<ParsedExport | null>(null);
  const refreshProjects = useCallback(async () => {
    setProjects(await listProjects(db, tenant));
    setEgressRules(await listEgressRules(db, tenant));
  }, [db, tenant]);
  useEffect(() => {
    Promise.all([listProjects(db, tenant), listEgressRules(db, tenant)]).then(
      ([list, rules]) => {
        setProjects(list);
        setEgressRules(rules);
      },
      (e: unknown) => {
        setProblem(String(e));
      },
    );
  }, [db, tenant]);
  const refreshThreads = useCallback(async () => {
    const list = await listThreads(db, tenant);
    setThreadList({ threads: list, at: Date.now() });
  }, [db, tenant]);
  const refreshMemory = useCallback(async () => {
    setMemories(await listMemories(db, tenant));
    setMemoryRecords(await listMemoryRecords(db, tenant));
    setProposals(await listPendingProposals(db, tenant));
    setReplaced(await listReplaced(db, tenant));
  }, [db, tenant]);
  useEffect(() => {
    Promise.all([
      listMemories(db, tenant),
      listMemoryRecords(db, tenant),
      listPendingProposals(db, tenant),
    ]).then(([saved, records, waiting]) => {
      setMemories(saved);
      setMemoryRecords(records);
      setProposals(waiting);
    }, report);
    getMemorySettings(db, tenant).then(setMemorySettingsState, report);
    listPrompts(db, tenant).then(setPrompts, report);
    Promise.all([
      getSetting(db, tenant, CAPS_SETTING),
      getSetting(db, tenant, RAISED_SETTING),
    ]).then(([rawCaps, rawRaised]) => {
      setCaps(parseCaps(rawCaps));
      setRaises(parseRaises(rawRaised));
    }, report);
    getSetting(db, tenant, DEFAULTS_SETTING).then((raw) => {
      setModelDefaults(parseDefaults(raw));
    }, report);
    Promise.all([
      getSetting(db, tenant, FETCHED_SETTING),
      getSetting(db, tenant, EDITS_SETTING),
      getSetting(db, tenant, CUSTOM_MODELS_SETTING),
      getSetting(db, tenant, MODEL_CHECK_SETTING),
      getSetting(db, tenant, POLICY_SETTING),
      getSetting(db, tenant, PROJECT_RULES_SETTING),
      getSetting(db, tenant, OVERRIDES_SETTING),
      getSetting(db, tenant, DISMISSED_SETTING),
    ]).then(([fetched, edits, custom, check, savedRouting, projectRouting, moved, dismissed]) => {
      setOverrides(parseJsonList<Override>(moved));
      setDismissedSuggestions(parseJsonList<string>(dismissed));
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
  // F5: reloads can overlap (one starts on an answer's first words, another when it ends), and
  // only the newest may show: an older one landing last would put the answer back to streaming.
  const reloads = useRef(0);
  const reload = useCallback(
    async (threadId: string) => {
      const ticket = ++reloads.current;
      const { rows, all, attached, cited, used, upto, fromFiles, artifacts } =
        await loadThread(threadId);
      const runs: Awaited<ReturnType<typeof runsForThread>> = repoApi
        ? await runsForThread(db, tenant, threadId)
        : new Map<string, never>();
      if (selectedRef.current === threadId && ticket === reloads.current) {
        setThreadRuns(
          new Map(
            [...runs].map(([id, r]) => [
              id,
              { run: r.run, steps: r.steps, changes: r.changes, streaming: "" },
            ]),
          ),
        );
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
    [loadThread, repoApi, db, tenant],
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

  // AR-06: artifacts found by search, by key, for opening and attaching them.
  const foundArtifacts = useRef(new Map<string, ArtifactHit>());
  const search = useCallback(
    async (text: string): Promise<SearchHitView[]> => [
      ...(await searchArtifacts(db, tenant, text)).map((a) => {
        foundArtifacts.current.set(a.id, a);
        return {
          key: `artifact-${a.id}`,
          threadId: a.threadId,
          threadTitle: a.title,
          messageId: null,
          kind: `Artifact in ${a.threadTitle}`,
          snippet: artifactSnippet(a.content, text),
          date: new Date(a.updatedAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          }),
          artifactKey: a.key,
        };
      }),
      ...(await searchChats(db, tenant, text)).map((h) => ({
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
    ],
    [db, tenant],
  );
  /** AR-06: puts an artifact into the composer as an attachment, for any chat to use. */
  const attachArtifact = (hit: SearchHitView) => {
    const found = foundArtifacts.current.get(hit.key.replace(/^artifact-/, ""));
    if (!found) return;
    setSearchOpen(false);
    setView("chat");
    attachments.addText(found.title, found.content).catch(report);
  };
  /** Opens a search result: its chat, on the branch that holds the message, scrolled to it. */
  const openHit = (hit: SearchHitView) => {
    setSearchOpen(false);
    if (hit.artifactKey) {
      const key = hit.artifactKey;
      select(hit.threadId);
      showArtifact(key);
      return;
    }
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
  // RT-06: speeds refresh as answers come in (the thread list's time moves with each one).
  useEffect(() => {
    medianFirstTokenMs(db, tenant, Date.now() - 7 * 86_400_000).then(setLatency, report);
  }, [db, tenant, at]);
  // MM-09: what each key spent today and this month (refreshed as answers come in).
  useEffect(() => {
    const now = Date.now();
    Promise.all([
      spentByProvider(db, tenant, periodStart("day", now)),
      spentByProvider(db, tenant, periodStart("month", now)),
    ]).then(([day, month]) => {
      setKeySpend({ day, month });
    }, report);
  }, [db, tenant, at]);
  const keyedProviders = keys.keys.filter((k) => k.saved).map((k) => k.provider);
  const capStates = keyedProviders.map((p) =>
    capState(
      p,
      caps[p] ?? {},
      { today: keySpend.day[p] ?? 0, month: keySpend.month[p] ?? 0 },
      raises[p],
      at,
    ),
  );
  /** Keys past their spend cap (and not raised for today): no calls on them (MM-09). */
  const stoppedProviders = capStates.filter((s) => s.over && !s.raised).map((s) => s.provider);
  /** SE-13: the policy of the project being written in (or the global rules). */
  const egress = policyFor(
    projects.find(
      (p) => p.id === (threads.find((t) => t.id === selectedId)?.projectId ?? draftProject),
    ) ?? null,
    egressRules,
  );
  /** Why this project can't send to any provider with a key; null when one is allowed. */
  const egressBlock =
    keyedProviders.length > 0 && keyedProviders.every((p) => egressRefusal(egress, p, "chat"))
      ? egressRefusal(egress, keyedProviders[0] ?? "anthropic", "chat")
      : null;
  const savedProviders: ProviderId[] = keyedProviders.filter(
    (p) => !stoppedProviders.includes(p) && egressRefusal(egress, p, "chat") === null,
  );
  const raiseCap = (p: ProviderId) => {
    const next = { ...raises, [p]: localDay(Date.now()) };
    setRaises(next);
    setSetting(db, tenant, RAISED_SETTING, JSON.stringify(next)).catch(report);
  };
  const providerName = (p: ProviderId) => (p === "anthropic" ? "Anthropic" : "OpenAI");
  /** RT-11: notes an answer moved up a tier (only stronger moves count). */
  const noteOverride = (o: Override) => {
    setOverrides((list) => {
      const next = withOverride(list, o);
      if (next.length !== list.length || next.at(-1) !== list.at(-1)) {
        setSetting(db, tenant, OVERRIDES_SETTING, JSON.stringify(next)).catch(report);
      }
      return next;
    });
  };
  const ruleSuggestions = suggestRules(globalPolicy, overrides, dismissedSuggestions, at);
  const dismissSuggestion = (key: string) => {
    const next = [...dismissedSuggestions, key];
    setDismissedSuggestions(next);
    setSetting(db, tenant, DISMISSED_SETTING, JSON.stringify(next)).catch(report);
  };
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
  const savedMode: RouteMode = openThread
    ? pickedMode?.threadId === openThread.id
      ? pickedMode.mode
      : modeOf(openThread)
    : draftMode;
  // RT-01: a pin for the next message only overrides the chat's mode, then clears.
  const mode: RouteMode = oneShot ?? savedMode;
  /** The chat keeps to its provider on a price tie (RT-06). */
  const stayOn = lastModelOf(messages, catalog)?.provider;
  /** RT-06: "stay on this provider" for this chat, when that provider has a key. */
  const stayProvider =
    openThread?.stayProvider && savedProviders.includes(openThread.stayProvider)
      ? openThread.stayProvider
      : undefined;
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
      tierModels(policy, catalog, tier, {
        providers,
        latency,
        ...(stayOn ? { prefer: stayOn } : {}),
      })[0];
    const fallback = catalog.models[0];
    if (!fallback) throw new Error("The model catalog is empty");
    return (
      (stayProvider ? pick([stayProvider]) : undefined) ??
      pick(savedProviders) ??
      pick(["anthropic", "openai"]) ??
      fallback
    );
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
    const picked = { threadId: openThread.id, mode: next };
    setPickedMode(picked);
    setThreadPins(db, tenant, openThread.id, {
      tier: next.kind === "tier" ? next.tier : null,
      model: next.kind === "model" ? { provider: next.provider, id: next.id } : null,
    })
      .then(refreshThreads)
      .catch(report)
      // A later pick keeps its own until its reload lands.
      .finally(() => {
        setPickedMode((p) => (p === picked ? null : p));
      });
  };
  /** The model for one question under the current mode; null (with a message) if none can take it. */
  const routeFor = (
    text: string,
    files: FileRecord[],
    history: Message[],
    webSearch: boolean,
    downshift = false,
    /** RT-02: the classification after the Cheap tier's second opinion, when it was asked. */
    checked?: Classification,
    /** RT-12: compare mode sends to chosen models whatever the chat's mode. */
    modeOverride?: RouteMode,
  ) => {
    if (egressBlock) {
      setProblem(egressBlock);
      return null;
    }
    const task = checked ?? classify(classifyInput(text, files, history, webSearch));
    const routed = route(policy, catalog, modeOverride ?? mode, task, {
      providers: savedProviders,
      ...(stayOn ? { prefer: stayOn } : {}),
      ...(stayProvider ? { stay: stayProvider } : {}),
      latency,
      downshift,
    });
    if (!routed.ok) {
      // SE-13: say when the project's privacy settings, not a missing key, left nothing to use.
      const blockedHere = keyedProviders.filter((p) => egress.blocked.includes(p));
      setProblem(
        blockedHere.length
          ? `${routed.error} ${egress.projectName ? `The project “${egress.projectName}”` : "Your privacy settings"} block${egress.projectName ? "s" : ""} ${blockedHere.map(providerName).join(" and ")}; allow it in privacy settings to use its models.`
          : routed.error,
      );
      return null;
    }
    // MM-09: a model you picked on a key past its cap isn't called.
    if (stoppedProviders.includes(routed.model.provider)) {
      setProblem(
        `${providerName(routed.model.provider)} has reached its spend cap. Raise it for today, or pick another model (Ctrl+K).`,
      );
      return null;
    }
    // Say so on the answer when the Cheap tier's reading was used (RT-09).
    const second = checked?.signals.find((sig) => sig.startsWith("checked by "));
    return second
      ? { ...routed, info: { ...routed.info, reason: `${routed.info.reason} (${second})` } }
      : routed;
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
    const helper = housekeepingModel(
      policy,
      catalog,
      "title",
      savedProviders,
      model.provider,
      localHelper,
    );
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
      localHelper,
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
    /** Start a run (Code) instead of answering; the project is null outside one (WF-02). */
    runIn: { projectId: string | null; kind: "code" | "work" } | null = null,
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
    const chatProject = threads.find((t) => t.id === threadId)?.projectId ?? draftProject;
    const input = {
      threadId,
      model: routed.model,
      route: routed.info,
      fallback: routed.fallback,
      defaults: (m: CatalogModel) =>
        resolveDefaults(modelDefaults, {
          provider: m.provider,
          id: m.id,
          tier: tierOf(policy, m) ?? null,
          projectId: chatProject,
        }),
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
      const runMode =
        codeMode[threadId] ??
        codeMode.draft ??
        projects.find((p) => p.id === runIn?.projectId)?.runMode ??
        "ask";
      // RT-14: on Auto, the cheapest Best model plans; a pinned tier or model does it all.
      const planner = routed.info.mode === "auto" ? routed.info.best : null;
      const result = await (runIn && repoApi && job.kind === "send" && webApp
        ? startOnServer(
            {
              threadId,
              projectId: runIn.projectId,
              kind: runIn.kind,
              task: job.text,
              model: { provider: routed.model.provider, id: routed.model.id },
              mode: runMode,
              newBranch: codeBranch[threadId] ?? codeBranch.draft ?? false,
              planner: planner ? { provider: planner.provider, id: planner.id } : null,
            },
            controller.signal,
          ).then(() => ({ status: "complete" as const, failedOverFrom: undefined }))
        : runIn && repoApi && job.kind === "send"
          ? startChatRun(runDeps(repoApi), {
              threadId,
              projectId: runIn.projectId,
              kind: runIn.kind,
              task: job.text,
              model: routed.model,
              mode: runMode,
              newBranch: codeBranch[threadId] ?? codeBranch.draft ?? false,
              planner,
              signal: controller.signal,
              onProgress: (answerId, p) => {
                setThreadRuns((m) => new Map(m).set(answerId, p));
                if (!loaded) {
                  loaded = true;
                  void reload(threadId);
                  void refreshThreads();
                }
              },
            }).then((run) => ({
              status: run.status === "done" ? ("complete" as const) : ("stopped" as const),
              failedOverFrom: undefined,
            }))
          : job.kind === "send"
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

  /** The open chat, or a new one made from the draft's settings. */
  const threadForSend = async (search: boolean): Promise<string> => {
    if (selectedId !== null) return selectedId;
    const thread = await createThread(db, tenant, undefined, draftProject, draftIncognito);
    const threadId = thread.id;
    if (search) await setThreadWebSearch(db, tenant, threadId, true);
    if (draftInstructions) {
      await setThreadInstructions(db, tenant, threadId, draftInstructions);
    }
    if (draftMode.kind !== "auto") {
      await setThreadPins(db, tenant, threadId, {
        tier: draftMode.kind === "tier" ? draftMode.tier : null,
        model:
          draftMode.kind === "model" ? { provider: draftMode.provider, id: draftMode.id } : null,
      });
    }
    // WF-02: folders picked for the draft become the new chat's.
    const pending = chatFolderMap.draft ?? [];
    for (const f of pending) await linkThreadFolder(db, tenant, threadId, f.id);
    if (pending.length > 0) {
      setChatFolderMap((m) => ({ ...m, [threadId]: pending, draft: [] }));
    }
    // So do its Work or Code switch, run mode and branch choice: without this, the second
    // message in a new Work chat went out as plain chat.
    const fromDraft = <T,>(m: Record<string, T>): Record<string, T> => {
      const { draft, ...rest } = m;
      return draft === undefined ? m : { ...rest, [threadId]: draft };
    };
    setCodeOn(fromDraft);
    setCodeMode(fromDraft);
    setCodeBranch(fromDraft);
    setSelectedId(threadId);
    selectedRef.current = threadId;
    await refreshThreads();
    return threadId;
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
    // LL-05: a large file is searched by its words on this computer, so no OpenAI key is needed.
    const search = searchOn;
    // LL-01: a sum, conversion or check is answered by a fixed rule before anything is routed
    // or spent. Only on Auto with nothing attached, outside coding runs and compare mode, and
    // when the project hasn't turned it off.
    const fixed =
      mode.kind === "auto" &&
      !thinkHarder &&
      ready.length === 0 &&
      compareKeys.length < 2 &&
      !codeActive &&
      projects.find((p) => p.id === activeProjectId)?.answerWithoutModel !== false
        ? answerWithoutModel(text, Date.now())
        : null;
    if (fixed) {
      try {
        const threadId = await threadForSend(search);
        await sendWithoutModel(deps, { threadId, text, answer: fixed });
        await reload(threadId);
        await refreshThreads();
      } catch (e) {
        report(e);
      }
      return;
    }
    // CO-03 / RT-10: budgets past 80% lower Auto a tier; past 100% the send asks first.
    const gate = sendGate(await budgetStatesFor(budgets, activeProjectId));
    if (gate.over && !confirmed.over) {
      setOverAsk({ state: gate.over, text, thinkHarder });
      return;
    }
    // RT-12: compare mode answers with each chosen model; the first goes like a normal send.
    const comparing = compareKeys.flatMap((k) => {
      const m = catalog.models.find((c) => modelKey(c) === k);
      return m ? [m] : [];
    });
    const compareFirst = comparing.length >= 2 ? comparing[0] : undefined;
    const compareMode: RouteMode | undefined = compareFirst
      ? { kind: "model", provider: compareFirst.provider, id: compareFirst.id }
      : undefined;
    // RT-02: when the heuristics are unsure, Auto asks the Cheap tier too (never in incognito).
    const local = classify(classifyInput(text, ready, messages, search));
    const checker =
      mode.kind === "auto" && !compareMode && local.unsure && !incognito
        ? housekeepingModel(
            policy,
            catalog,
            "classify",
            savedProviders,
            model.provider,
            localHelper,
          )
        : null;
    const checked = checker
      ? await checkClassification(deps, catalog, checker, local, text, selectedId)
      : undefined;
    const routedFirst = routeFor(
      text,
      ready,
      messages,
      search,
      gate.downshift !== null,
      checked,
      compareMode,
    );
    if (!routedFirst) return;
    const found = compareMode
      ? {
          ...routedFirst,
          fallback: null,
          info: {
            ...routedFirst.info,
            reason: `Compare: 1 of ${String(comparing.length)} (${routedFirst.model.displayName})`,
          },
        }
      : routedFirst;
    // RT-11: a pinned tier above what Auto would have picked counts as an override.
    if (mode.kind === "tier" && !compareMode && !incognito) {
      const task = checked ?? local;
      const auto = route(policy, catalog, AUTO, task, { providers: savedProviders });
      if (auto.ok && auto.info.tier) {
        noteOverride({
          intent: task.intent,
          complexity: task.complexity,
          from: auto.info.tier,
          to: mode.tier,
          at: Date.now(),
        });
      }
    }
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
      const threadId = await threadForSend(search);
      await stream(
        threadId,
        routed,
        { kind: "send", text, files: sent },
        search,
        runKind ? { projectId: activeProjectId ?? null, kind: runKind } : null,
      );
      if (compareMode) {
        setCompareKeys([]);
        await compareRest(threadId, comparing.slice(1), local, search);
      }
    } catch (e) {
      report(e);
    }
  };
  /** RT-12: the other compared models answer the same question as sibling branches. */
  const compareRest = async (
    threadId: string,
    others: CatalogModel[],
    task: Classification,
    search: boolean,
  ) => {
    const { rows } = await loadThread(threadId);
    const first = rows.findLast((m) => m.role === "assistant");
    const question = first && rows.find((m) => m.id === first.parentId);
    if (!first || !question) return;
    const total = others.length + 1;
    for (const [i, other] of others.entries()) {
      const routed = route(
        policy,
        catalog,
        { kind: "model", provider: other.provider, id: other.id },
        task,
        { providers: savedProviders },
      );
      if (!routed.ok) {
        setProblem(routed.error);
        continue;
      }
      const info = {
        ...routed.info,
        reason: `Compare: ${String(i + 2)} of ${String(total)} (${other.displayName})`,
      };
      await stream(
        threadId,
        { ...routed, info },
        { kind: "regenerate", answerId: first.id, questionId: question.id },
        search,
      );
    }
    if (selectedRef.current === threadId) setSideBySide(first.id);
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
    // RT-11: moving an Auto answer up is an override of how it was routed.
    const original = answer.route;
    const thread = threads.find((t) => t.id === selectedId);
    if (original?.mode === "auto" && !thread?.incognito) {
      noteOverride({
        intent: task.intent,
        complexity: task.complexity,
        from: step.from,
        to: step.to,
        at: Date.now(),
      });
    }
    void stream(
      selectedId,
      { ...routed, info },
      { kind: "escalate", answerId: answer.id },
      searchOn,
    );
  };
  const stop = useCallback(() => {
    if (selectedRef.current) controllers.current.get(selectedRef.current)?.abort();
    // M10 step 6: a run in the web app is the runner's: Stop asks it to stop.
    if (webApp) {
      for (const r of threadRuns.values()) {
        if (r.run.status === "running") {
          askToStop(db, tenant, r.run.id).catch((e: unknown) => {
            setProblem(e instanceof Error ? e.message : String(e));
          });
        }
      }
    }
  }, [webApp, threadRuns, db, tenant]);

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
      localHelper,
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
      // PM-11: ones that may contradict a saved fact wait for a choice.
      const open = proposalViews.filter((p) => p.conflict);
      for (const p of proposals) {
        if (!open.some((o) => o.id === p.id)) await approveProposal(db, tenant, p.id);
      }
      await refreshMemory();
      if (open.length === 0) setReviewOpen(false);
    })().catch(report);
  };
  const replaceWithProposal = (id: string, text: string, replaceId: string) => {
    const secret = findSecret(text);
    if (secret) {
      setProblem(`That looks like ${SECRET_LABELS[secret]}. Memory never stores those.`);
      return;
    }
    approveProposal(db, tenant, id, text, replaceId).then(refreshMemory).catch(report);
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
  const memoryViews: MemoryView[] = memoryRecords.map((m) => ({
    id: m.id,
    text: m.text,
    kind: m.kind,
    projectId: m.scope === "conversation" ? null : m.projectId,
    projectName: m.scope === "conversation" ? null : projectName(m.projectId),
    threadId: m.threadId,
    threadName: m.threadId ? (threads.find((t) => t.id === m.threadId)?.title ?? "a chat") : null,
    source: m.sourceThreadTitle,
    date: shortDate(m.createdAt),
    confidence: m.confidence,
    authority: m.authority,
    extractionMethod: m.extractionMethod,
    extractionModel: m.extractionModel,
    status:
      m.status === "excluded" || m.status === "expired"
        ? m.status
        : m.expiresAt !== null && m.expiresAt <= Date.now()
          ? "expired"
          : "active",
    sensitivity: m.sensitivity,
    maySend: m.maySend,
    expiresAt: m.expiresAt,
    lastVerifiedAt: m.lastVerifiedAt,
    revision: m.revision,
  }));
  const proposalViews: ProposalView[] = proposals.map((p) => {
    // PM-11: a new fact about something already saved asks which stands.
    const conflict = p.op === "add" ? conflictWith(memories, p.text, p.kind) : null;
    return {
      id: p.id,
      op: p.op,
      text: p.text,
      currentText: p.currentText,
      kind: p.kind,
      projectName: projectName(p.projectId),
      source: p.sourceThreadTitle,
      confidence: p.confidence,
      ...(conflict ? { conflict: { id: conflict.id, text: conflict.text } } : {}),
    };
  });
  const copyMemories = () => {
    const text = (Object.keys(KIND_LABELS) as Memory["kind"][])
      .map((c) => {
        const list = memories.filter((m) => m.kind === c);
        return list.length ? `${KIND_LABELS[c]}\n${list.map((m) => `- ${m.text}`).join("\n")}` : "";
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
  // WF-02: Code works wherever the chat has a folder: its own, or its project's.
  const chatOwnFolders = chatFolderMap[selectedId ?? "draft"] ?? [];
  const sharedFolders = activeProjectId ? (projectFolderMap[activeProjectId] ?? []) : [];
  const chatFolders = [
    ...chatOwnFolders,
    ...sharedFolders.filter((f) => !chatOwnFolders.some((o) => o.id === f.id)),
  ];
  const codeAvailable = Boolean(chatFolders.length > 0 && repoApi);
  useEffect(() => {
    if (activeProjectId) loadProjectFolders(activeProjectId).catch(report);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the project changes
  }, [activeProjectId, activeProject?.repoRoot]);
  useEffect(() => {
    if (selectedId) loadChatFolders(selectedId).catch(report);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the chat changes
  }, [selectedId]);
  // M10 step 5: the web app's folder dialog, waiting for a path on HULK; null when closed.
  const [folderAsk, setFolderAsk] = useState<((info: RepoInfo | null) => void) | null>(null);
  /** The native folder picker on the desktop; on the web, a folder on HULK typed in. */
  const pickFolder = (api: RepoApi): Promise<RepoInfo | null> =>
    webApp
      ? new Promise((resolve) => {
          setFolderAsk(() => resolve);
        })
      : api.pick();
  /** WF-02: pick a folder on this computer for this chat (or the draft). */
  const addChatFolder = () => {
    if (!repoApi) return;
    pickFolder(repoApi)
      .then(async (info) => {
        if (!info) return;
        const folder = await grantFolder(db, tenant, info.root);
        if (selectedId) {
          await linkThreadFolder(db, tenant, selectedId, folder.id);
          await loadChatFolders(selectedId);
        } else {
          setChatFolderMap((m) => ({
            ...m,
            draft: [...(m.draft ?? []).filter((f) => f.id !== folder.id), folder],
          }));
        }
      })
      .catch(report);
  };
  const removeChatFolder = (folderId: string) => {
    if (selectedId) {
      unlinkThreadFolder(db, tenant, selectedId, folderId)
        .then(() => loadChatFolders(selectedId))
        .catch(report);
    } else {
      setChatFolderMap((m) => ({ ...m, draft: (m.draft ?? []).filter((f) => f.id !== folderId) }));
    }
  };
  /** Everything a run needs: the repository, commands, and a way to ask you first. */
  const runDeps = (repo: RepoApi) => ({
    ...deps,
    repo,
    // CA-08: the Cheap tier summarizes a long run's earlier steps.
    ...(() => {
      const helper = housekeepingModel(policy, catalog, "summary", savedProviders, model.provider);
      return helper ? { summarizer: helper } : {};
    })(),
    ...(execApi ? { exec: execApi } : {}),
    ...(gitApi ? { git: gitApi } : {}),
    // M9 step 6: run_python is offered once Python is installed (Settings).
    ...(pythonApi ? { pythonReady: () => pythonApi.status().then((r) => r !== null) } : {}),
    approve: (req: ApprovalRequest) =>
      new Promise<ApprovalAnswer>((resolve) => {
        const done = (a: ApprovalAnswer) => {
          setApprovals((all) => {
            const next = new Map(all);
            next.delete(req.runId);
            return next;
          });
          resolve(a);
        };
        req.signal?.addEventListener("abort", () => {
          done("no");
        });
        setApprovals((m) => new Map(m).set(req.runId, { request: req, answer: done }));
      }),
  });
  const codeKey = selectedId ?? "draft";
  const runKind = codeAvailable ? codeOn[codeKey] || null : null;
  const codeActive = runKind !== null;
  /** M6: goes on with a paused or stopped run in the open chat. */
  const continueRunHere = (runId: string, raise: boolean) => {
    if (!repoApi || !selectedId) return;
    if (webApp) {
      // M10 step 6: the runner picks it up; the poll below follows it.
      askToContinue(db, tenant, runId, raise ? DEFAULT_RUN_CAP_MICRO_USD : undefined).catch(report);
      return;
    }
    const threadId = selectedId;
    const controller = new AbortController();
    controllers.current.set(threadId, controller);
    continueChatRun(runDeps(repoApi), runId, {
      ...(raise ? { raiseCapBy: DEFAULT_RUN_CAP_MICRO_USD } : {}),
      signal: controller.signal,
      onProgress: (answerId, p) => {
        setThreadRuns((m) => new Map(m).set(answerId, p));
      },
    })
      .catch(report)
      .finally(() => {
        controllers.current.delete(threadId);
        void reload(threadId).catch(report);
        void refreshThreads().catch(report);
      });
    void reload(threadId).catch(report);
  };

  /**
   * M10 step 6: the web app asks the server's runner to start a run, and waits only until it has
   * started (or couldn't). Following it is the poll's job: the page never runs the loop itself,
   * so closing it doesn't stop the run. Stop before it has started stops it once it has.
   */
  const startOnServer = async (input: StartInput, signal: AbortSignal): Promise<void> => {
    const requestId = await askToStart(db, tenant, input);
    for (;;) {
      const r = await getRequest(db, tenant, requestId);
      if (r?.runId) {
        if (signal.aborted) await askToStop(db, tenant, r.runId);
        return;
      }
      if (!r || r.status === "failed") {
        setProblem(r?.error ?? "The server lost that request. Try again.");
        return;
      }
      await sleep(WEB_POLL_MS);
    }
  };

  // M10 steps 6 and 8: what the web app shows of the runner's work, read every second: the
  // questions waiting for anyone, the Runs list and its badge, and the open chat's runs.
  const [serverRuns, setServerRuns] = useState<{
    recent: RecentRun[];
    waiting: Set<string>;
    ended: number;
  } | null>(null);
  const runsSeenAt = useRef(readRunsSeen());
  const follow = useRef({ reload, refreshThreads, report });
  useEffect(() => {
    follow.current = { reload, refreshThreads, report };
  });
  useEffect(() => {
    if (!webApp) return;
    const threadId = selectedId;
    // Asked through a function, so the checks after each await see the cleanup's change.
    const life = { stopped: false };
    const gone = () => life.stopped;
    let busy = false;
    // Each run's status and last change, as last loaded: only what changed is loaded again.
    const seen = new Map<string, string>();
    let shownQuestions = "";
    let shownRuns = "";
    const tick = async () => {
      const open = await openApprovals<ApprovalRequest>(db, tenant);
      const recent = await recentRuns(db, tenant, 50);
      const ended = await runsEndedSince(db, tenant, runsSeenAt.current);
      if (gone()) return;
      // Only a change re-renders the app.
      const runsNow = `${recent.map((r) => `${r.id}:${r.status}:${String(r.updatedAt)}`).join()}|${open.map((a) => a.runId).join()}|${String(ended)}`;
      if (runsNow !== shownRuns) {
        shownRuns = runsNow;
        setServerRuns({ recent, waiting: new Set(open.map((a) => a.runId)), ended });
      }
      const questions = open.map((a) => a.id).join();
      if (questions !== shownQuestions) {
        shownQuestions = questions;
        setApprovals(
          new Map(
            open.map((a) => [
              a.runId,
              {
                // As the runner saved it: the question without its signal.
                request: a.request,
                answer: (answer: ApprovalAnswer) => {
                  // False means another page (or Stop) answered first: the card just goes.
                  setApprovals((all) => {
                    const next = new Map(all);
                    next.delete(a.runId);
                    return next;
                  });
                  answerApproval(db, tenant, a.id, answer).catch(follow.current.report);
                },
              },
            ]),
          ),
        );
      }
      if (!threadId) return;
      const updates: [string, RunProgress][] = [];
      let endedHere = false;
      for (const s of await runStatesForThread(db, tenant, threadId)) {
        const mark = `${s.status}:${String(s.updatedAt)}`;
        const before = seen.get(s.id);
        const going = s.status === "running" || s.status === "paused";
        if (!going && before === mark) continue;
        if (before?.startsWith("running:") && s.status !== "running") endedHere = true;
        seen.set(s.id, mark);
        const run = await getRun(db, tenant, s.id);
        if (!run) continue;
        updates.push([
          s.messageId,
          {
            run,
            steps: await listSteps(db, tenant, s.id),
            changes: await listChanges(db, tenant, s.id),
            streaming: s.status === "running" ? await getLive(db, tenant, s.id) : "",
          },
        ]);
      }
      if (gone() || selectedRef.current !== threadId) return;
      if (updates.length > 0) {
        setThreadRuns((m) => {
          const next = new Map(m);
          for (const [messageId, p] of updates) next.set(messageId, p);
          return next;
        });
      }
      if (endedHere) {
        await follow.current.reload(threadId);
        await follow.current.refreshThreads();
      }
    };
    const poll = () => {
      if (busy || gone()) return;
      busy = true;
      tick()
        .catch((e: unknown) => {
          follow.current.report(e);
        })
        .finally(() => {
          busy = false;
        });
    };
    poll();
    const timer = setInterval(poll, WEB_POLL_MS);
    return () => {
      life.stopped = true;
      clearInterval(timer);
    };
  }, [webApp, selectedId, db, tenant]);
  const openRuns = () => {
    const at = Date.now();
    runsSeenAt.current = at;
    saveRunsSeen(at);
    setServerRuns((s) => (s ? { ...s, ended: 0 } : s));
    setView("runs");
  };
  const runsBadge = serverRuns ? serverRuns.waiting.size + serverRuns.ended : 0;
  const instructionParts = effectiveInstructions(
    globalInstructions ?? NO_INSTRUCTIONS,
    activeProject?.instructions ?? "",
    chatInstructions,
    activeProject?.id && repoFiles.projectId === activeProject.id ? repoFiles.files : [],
  );
  const repoProjectId = activeProject?.repoRoot ? activeProject.id : null;
  const repoRootNow = activeProject?.repoRoot ?? null;
  useEffect(() => {
    if (!repoProjectId || !repoApi) return;
    let live = true;
    listProjectFolders(db, tenant, repoProjectId)
      .then((folders) => instructionsIn(repoApi, folders))
      .then((files) => {
        if (live) setRepoFiles({ projectId: repoProjectId, files });
      })
      .catch(report);
    return () => {
      live = false;
    };
  }, [db, tenant, repoProjectId, repoRootNow, repoApi]); // report changes every render, like the effects above
  const moveThread = (projectId: string | null) => {
    if (!thread) return;
    setThreadProject(db, tenant, thread.id, projectId).then(refreshThreads).catch(report);
  };
  const editedProject = projects.find((p) => p.id === projectDialog);
  // M10 step 9: the edited project's scheduled tasks (the web app only runs them).
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const editedId = editedProject?.id ?? null;
  const refreshSchedules = useCallback(async () => {
    setSchedules(editedId && webApp ? await listSchedules(db, tenant, editedId) : []);
  }, [db, tenant, editedId, webApp]);
  useEffect(() => {
    refreshSchedules().catch((e: unknown) => {
      setProblem(e instanceof Error ? e.message : String(e));
    });
  }, [refreshSchedules]);
  /** A new task starts on the project's model, or the Balanced tier's usual one. */
  const scheduleDefaults = (): ScheduleDefaults => {
    // With no key saved yet (a new server), any provider will do: it only picks the default.
    const providers: ProviderId[] =
      savedProviders.length > 0 ? savedProviders : ["anthropic", "openai"];
    const balanced = tierModels(policy, catalog, "balanced", { providers })[0];
    const m = editedProject?.defaultModel ?? balanced ?? catalog.models[0];
    return {
      kind: "code",
      mode: editedProject?.runMode ?? "ask",
      model: { provider: m?.provider ?? "anthropic", id: m?.id ?? "" },
      capMicroUsd: DEFAULT_RUN_CAP_MICRO_USD,
    };
  };
  useEffect(() => {
    if (!projectDialog) return;
    listAllowedCommands(db, tenant, projectDialog).then(setAllowedCommands, report);
    projectToolsOff(db, tenant, projectDialog).then(setToolsOff, report);
    listProjectMcpServers(db, tenant, projectDialog).then((l) => {
      setProjectServers(new Set(l.map((s) => s.id)));
    }, report);
  }, [db, tenant, projectDialog]);
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
    projectArtifacts(db, tenant, projectId).then(setProjectArts, report);
    listDecisions(db, tenant, projectId).then(setProjectDecisions, report);
    listTasks(db, tenant, projectId).then(setProjectTasks, report);
  }, [projectDialog, db, tenant]);
  /** Runs a change to the open project's tasks, then reloads them and memory. */
  const changeTasks = (change: (projectId: string) => Promise<unknown>) => {
    const projectId = projectDialog;
    if (!projectId || projectId === "new") return;
    change(projectId)
      .then(() => listTasks(db, tenant, projectId))
      .then(setProjectTasks)
      .then(refreshMemory)
      .catch(report);
  };
  const taskViews: TaskView[] = projectTasks.map((t) => ({
    id: t.id,
    text: t.text,
    status: t.taskStatus ?? "open",
    dependsOn: t.dependsOn,
    blockedBy: blockedBy(t, projectTasks).map((b) => b.text),
  }));
  const taskProblem = (text: string) => {
    const secret = findSecret(text);
    if (secret) setProblem(`That looks like ${SECRET_LABELS[secret]}. Memory never stores those.`);
    return secret !== null;
  };
  /** Runs a change to the open project's decisions, then reloads them and memory. */
  const changeDecisions = (change: (projectId: string) => Promise<unknown>) => {
    const projectId = projectDialog;
    if (!projectId || projectId === "new") return;
    change(projectId)
      .then(() => listDecisions(db, tenant, projectId))
      .then(setProjectDecisions)
      .then(refreshMemory)
      .catch(report);
  };
  const decisionViews: DecisionView[] = projectDecisions.map((d) => ({
    id: d.id,
    text: d.text,
    rationale: d.rationale,
    alternatives: d.alternatives,
    status: d.status === "superseded" ? "superseded" : "active",
    replacedBy: d.supersededById
      ? (projectDecisions.find((n) => n.id === d.supersededById)?.text ?? null)
      : null,
    date: new Date(d.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  }));
  /**
   * Indexes a project's files that aren't fully searchable yet: by word always (LL-05, on this
   * computer), and by meaning too with an OpenAI key the project allows.
   */
  const indexKnowledge = async (projectId: string) => {
    // SE-13: nothing is embedded for a project that forbids it, or from a file kept on device.
    const model = allowedEmbedding(
      await projectPolicy(db, tenant, projectId),
      embeddingModel(catalog, keyedProviders),
    );
    const files = await listProjectFiles(db, tenant, projectId);
    for (const f of files.filter(
      (x) => x.maySend && (x.chunks === 0 || (model !== null && x.embedded < x.chunks)),
    )) {
      await ensureIndexed(
        { db, tenant, adapterFor, files: filesApi, priceVersion: catalog.priceVersion },
        model,
        f,
        { kind: "project", id: projectId },
      );
    }
    return listProjectFiles(db, tenant, projectId);
  };
  /** FK-07: the name of a folder by id, from any project's folders. */
  const folderLabel = (folderId: string) => {
    const f = Object.values(projectFolderMap)
      .flat()
      .find((x) => x.id === folderId);
    return f ? folderName(f.path) : "its folder";
  };
  /**
   * FK-07: brings a project's folder documents into its knowledge and indexes what changed. A
   * full pass hashes every document; a quick one reads only those with a new size or time.
   */
  const folderSyncing = useRef(new Set<string>());
  const syncFolders = async (projectId: string, full: boolean) => {
    if (!repoApi || folderSyncing.current.has(projectId)) return;
    folderSyncing.current.add(projectId);
    try {
      const r = await syncFolderKnowledge(
        { db, tenant, repo: repoApi, files: filesApi },
        projectId,
        full,
      );
      if (r.added + r.updated + r.removed > 0 || full) {
        const files = await indexKnowledge(projectId).catch(() =>
          listProjectFiles(db, tenant, projectId),
        );
        setKnowledge((k) => (k?.projectId === projectId ? { ...k, files } : k));
      }
    } finally {
      folderSyncing.current.delete(projectId);
    }
  };
  const syncFoldersRef = useRef(syncFolders);
  syncFoldersRef.current = syncFolders;
  // FK-07: every project's folders checked by hash at start, then by size and time each minute
  // while FUSE runs (no file watcher: this works the same on every platform and drive).
  useEffect(() => {
    if (!repoApi) return;
    const pass = (full: boolean) =>
      listProjects(db, tenant)
        .then(async (ps) => {
          for (const p of ps) {
            if ((await listProjectFolders(db, tenant, p.id)).length > 0) {
              await syncFoldersRef.current(p.id, full);
            }
          }
        })
        .catch(() => {
          // A failed pass is tried again on the next tick.
        });
    void pass(true);
    const timer = setInterval(() => void pass(false), 60_000);
    return () => {
      clearInterval(timer);
    };
  }, [db, tenant, repoApi]);
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
    // LL-05: chunked means searchable by word; embedded too means by meaning as well.
    const ready = f.chunks > 0;
    const byMeaning = ready && f.embedded >= f.chunks;
    return {
      id: f.id,
      name: f.name,
      tokens,
      ready,
      status: byMeaning
        ? "Searchable"
        : ready
          ? "Searchable by word"
          : knowledge?.busy
            ? "Indexing…"
            : "Not indexed",
      wholeMicro: Math.round((tokens * priceToMicro(model.price.input)) / 1_000_000),
      maySend: f.maySend,
      ...(f.folderId ? { folder: folderLabel(f.folderId) } : {}),
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
      const r = threadRuns.get(v.id);
      if (r) {
        v.run = runView(r.run, r.steps, r.streaming, r.changes);
        const waiting = approvals.get(r.run.id);
        if (waiting) {
          v.run.approval = approvalView(waiting.request);
          const flags = waiting.request.flags ?? [];
          if (flags.length) {
            v.run.approvalFlags = flags.map(({ source, why, passage }) => ({
              source,
              why,
              passage,
            }));
          }
        }
      }
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
    threadRuns,
    approvals,
  ]);
  // "Try a stronger model" goes on the latest answer only: earlier ones would need branching.
  const stronger = liveHere ? null : escalation(messages.findLast((m) => m.role === "assistant"));
  const latest = shown.at(-1);
  const withEscalation =
    stronger && latest?.role === "assistant"
      ? [...shown.slice(0, -1), { ...latest, escalateTo: tierLabel(stronger.to) }]
      : shown;
  // In the web app a run in this chat goes on in the runner, with no answer streaming here.
  const streaming =
    selectedId !== null &&
    (selectedId in live ||
      (webApp && [...threadRuns.values()].some((r) => r.run.status === "running")));
  const openSaved = threadArtifacts.find((a) => a.key === openArtifact);
  useEffect(() => {
    if (!openSaved) return;
    listVersions(db, tenant, openSaved.id).then(setVersions, report);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when a new version lands
  }, [db, tenant, openSaved?.id, openSaved?.version]);
  /** FK-10: shows an attached file in the side panel, optionally at a cited place. */
  const openFile = async (fileId: string, focus?: FileViewerView["focus"]) => {
    const file = await getFile(db, tenant, fileId);
    if (!file) {
      setProblem("That file isn't stored any more.");
      return;
    }
    const bytes = await filesApi.get(file.sha256);
    const base = { name: file.name, ...(focus ? { focus } : {}) };
    setOpenArtifact(null);
    setViewer(
      file.mime.startsWith("image/")
        ? {
            ...base,
            kind: "image",
            url: URL.createObjectURL(new Blob([bytes.slice()], { type: file.mime })),
          }
        : file.mime === "application/pdf"
          ? { ...base, kind: "pdf", bytes }
          : { ...base, kind: "text", text: new TextDecoder().decode(bytes) },
    );
  };
  /**
   * WF-05: a file a run made or changed, read from its folder and shown in the side panel:
   * Word and Excel as text and tables, PDFs as pages, images as images, anything else as text.
   */
  const previewChange = async (changeId: string) => {
    if (!repoApi) return;
    const change = await getChange(db, tenant, changeId);
    if (!change) return;
    const folders = await listRunFolders(db, tenant, change.runId);
    const { folder, rel } = resolvePath(folders, change.path);
    const base = {
      name: change.path,
      ...(webApp
        ? { openReason: WEB_REASONS.open }
        : repoApi.open
          ? {
              onOpen: () => {
                repoApi.open?.(folder.folderId, rel, false).catch(report);
              },
              onReveal: () => {
                repoApi.open?.(folder.folderId, rel, true).catch(report);
              },
            }
          : {}),
    };
    const kind = docKind(change.path);
    const bytes =
      kind !== "other" && repoApi.readBytes ? await repoApi.readBytes(folder.folderId, rel) : null;
    setOpenArtifact(null);
    if (kind === "image" && bytes) {
      const ext = change.path.split(".").at(-1)?.toLowerCase() ?? "png";
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      setViewer({
        ...base,
        kind: "image",
        url: URL.createObjectURL(new Blob([bytes.slice()], { type: mime })),
      });
    } else if (kind === "pdf" && bytes) {
      setViewer({ ...base, kind: "pdf", bytes });
    } else if ((kind === "word" || kind === "excel") && bytes) {
      setViewer({
        ...base,
        kind: "document",
        markdown: kind === "word" ? docxText(bytes) : xlsxText(bytes),
      });
    } else {
      const text = await repoApi.read(folder.folderId, rel, 0);
      setViewer({ ...base, kind: "text", text: text.content });
    }
  };
  /** FK-10: a cited excerpt opens its file there; excerpts from past chats have no file. */
  const openSource = async (chunkId: string) => {
    const chunk = await getChunk(db, tenant, chunkId);
    if (chunk?.sourceKind !== "file") {
      setProblem("That excerpt is from a past chat or a memory, not a file.");
      return;
    }
    await openFile(chunk.sourceId, {
      ...(chunk.page !== null ? { page: chunk.page } : {}),
      ...(chunk.lineStart !== null ? { lineStart: chunk.lineStart } : {}),
      ...(chunk.lineEnd !== null ? { lineEnd: chunk.lineEnd } : {}),
    });
  };
  const showArtifact = (key: string | null) => {
    if (key) setViewer(null);
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
  /** CH-11: the chat on screen, copied or saved. */
  const exportThread = async (format: ThreadExportFormat) => {
    const open = threads.find((t) => t.id === selectedId);
    if (!open) return;
    const markdown = chatMarkdown(open.title, open.createdAt, messages);
    if (format === "copy") {
      await navigator.clipboard.writeText(markdown);
      return;
    }
    if (!exporter) return;
    const bytes =
      format === "md"
        ? new TextEncoder().encode(markdown)
        : format === "pdf"
          ? await markdownToPdf(markdown, open.title)
          : new TextEncoder().encode(threadJson(open, threadAll));
    await exporter.save(fileName(open.title, format), bytes);
  };
  // CH-12: prompts for every chat, plus the ones for the project on screen.
  const usablePrompts = prompts.filter(
    (p) => p.projectId === null || p.projectId === activeProjectId,
  );
  /** Puts a saved prompt into the message box, asking for its {{variables}} first. */
  const applyPrompt = (id: string) => {
    const prompt = prompts.find((p) => p.id === id);
    if (!prompt) return;
    if (promptVariables(prompt.body).length > 0) {
      setFilling(prompt);
      return;
    }
    setView("chat");
    setQuote((q) => ({ text: prompt.body, key: (q?.key ?? 0) + 1 }));
  };
  const refreshPrompts = () => listPrompts(db, tenant).then(setPrompts);
  // RT-12: the models compare mode can send to: Balanced and Best, from providers with a key.
  const compareOptions = policy.tiers
    .filter((t) => t.id !== "cheap")
    .flatMap((t) =>
      t.models.flatMap((ref) => {
        const m = findModel(catalog, ref.provider, ref.id);
        return m && savedProviders.includes(m.provider)
          ? [{ key: modelKey(m), label: `${m.displayName} · ${t.label}` }]
          : [];
      }),
    );
  /** What the chosen models would cost for a draft: its input plus a typical 800-token answer. */
  const compareEstimate = (draft: string) => {
    if (compareKeys.length < 2) return null;
    const ready = attachments.pending.flatMap((p) => (p.file ? [p.file] : []));
    const tokens = classifyInput(draft, ready, messages, false).contextTokens ?? 0;
    const micro = compareKeys.reduce((sum, k) => {
      const m = catalog.models.find((c) => modelKey(c) === k);
      if (!m) return sum;
      const price = priceFor(m, tokens);
      return (
        sum + (tokens * priceToMicro(price.input) + 800 * priceToMicro(price.output)) / 1_000_000
      );
    }, 0);
    return `about ${money(Math.round(micro))}`;
  };
  // CH-17: the answer picked for side by side, with its sibling versions.
  const sideBySideAnswers = (() => {
    const picked = sideBySide ? threadAll.find((x) => x.id === sideBySide) : undefined;
    if (!picked) return null;
    // Every answer to the same question (not the stronger re-runs), oldest first.
    const siblings = threadAll
      .filter(
        (x) =>
          x.role === "assistant" && x.parentId === picked.parentId && x.escalatedFromId === null,
      )
      .sort((x, y) => x.createdAt - y.createdAt);
    return siblings.flatMap((m) => {
      const id = m.id;
      const provider = m.provider;
      const used =
        m.model && (provider === "openai" || provider === "anthropic")
          ? findModel(catalog, provider, m.model)
          : undefined;
      return [
        {
          id,
          model: used?.displayName ?? m.model ?? "Unknown model",
          cost: money(m.usage.costMicroUsd),
          content: m.content,
          current: messages.some((x) => x.id === id),
        },
      ];
    });
  })();
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
      ...(p.secrets
        ? { secrets: { summary: describeSecrets(p.secrets), canRemove: p.secrets.canRemove } }
        : {}),
    };
  });
  const sendingImages = attachments.pending.some(
    (p) => p.status !== "error" && (p.file?.mime.startsWith("image/") ?? p.url !== undefined),
  );
  const withSecrets = attachments.pending.find((p) => p.secrets);
  const blocked =
    sendingImages && mode.kind === "model" && !model.capabilities.includes("vision")
      ? `${model.displayName} can't read images. Pick another model (Ctrl+K).`
      : withSecrets
        ? `${withSecrets.name} looks like it holds ${describeSecrets(withSecrets.secrets ?? { lines: [], kinds: [] })}. Remove those lines or send it anyway.`
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
    recentToolCalls(db, tenant).then(setAudit, report);
  }, [view, db, tenant]);
  useEffect(() => {
    if (view !== "settings") return;
    budgetStatesFor(budgets, null, true).then(setBudgetStates, report);
    // LL-03: what this computer can run, read fresh each time Settings opens.
    void refreshLocalInstalled();
    shadowSummary(db, tenant, 0).then(setShadow, report);
    localApi?.hardware().then(
      (hw) => {
        setLocalHardware(hw);
        setLocalError(null);
      },
      (e: unknown) => {
        setLocalError(`Couldn't read this computer's hardware: ${String(e)}`);
      },
    );
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
  /**
   * LL-07: cost per successful task over 30 days. The first time a task has succeeded with every
   * call in the cloud, that figure is frozen as the baseline later savings are measured against.
   */
  const loadEconomics = async (at: number, freeze = false) => {
    const days = 30;
    const since = at - days * 86_400_000;
    const [tasks, spent, avoided, stored] = await Promise.all([
      listQuestionTasks(db, tenant, since),
      spentSince(db, tenant, since),
      cloudCallsAvoidedSince(db, tenant, since),
      getSetting(db, tenant, "economics.baseline"),
    ]);
    const e = taskEconomics(tasks, spent, avoided);
    let baseline = parseBaseline(stored);
    if (e.perSuccess !== null && (freeze || (!baseline && avoided === 0))) {
      baseline = { at, days, tasks: e.tasks, succeeded: e.succeeded, perSuccess: e.perSuccess };
      await setSetting(db, tenant, "economics.baseline", JSON.stringify(baseline));
    }
    setEconomicsView({
      days,
      tasks: e.tasks,
      succeeded: e.succeeded,
      perSuccess: e.perSuccess,
      cloudCallsAvoided: e.cloudCallsAvoided,
      baseline: baseline ? { at: baseline.at, perSuccess: baseline.perSuccess } : null,
      change: againstBaseline(e.perSuccess, baseline),
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
    loadEconomics(at).catch(report);
  };
  // Screenshots can open on the dashboard (FUSE_VIEW=usage): load it once at start.
  useEffect(() => {
    if (import.meta.env.VITE_FUSE_VIEW !== "usage") return;
    listUsage(db, tenant, 0).then((rows) => {
      setUsage({ rows, at: Date.now() });
    }, report);
    loadEconomics(Date.now()).catch(report);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once at start, for screenshots
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
      agent: "Coding runs",
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
    Promise.all([
      getSetting(db, tenant, LOCK_HASH),
      getSetting(db, tenant, LOCK_IDLE),
      getSetting(db, tenant, HELLO_SETTING),
      hello ? hello.available().catch(() => false) : Promise.resolve(false),
    ]).then(
      ([hash, idle, helloSetting, helloAvailable]) => {
        const minutes = idle === null ? DEFAULT_IDLE_MINUTES : Number(idle);
        setLock((l) => ({
          ...l,
          helloAvailable,
          helloOn: helloSetting === "on",
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
  }, [db, tenant, hello]);
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
  /** SE-03: unlocks when Windows Hello confirms it's you. */
  const unlockWithHello = async () => {
    if (!hello) return false;
    const ok = await hello.verify("Unlock FUSE");
    if (ok) {
      lastActive.current = Date.now();
      setLock((l) => ({ ...l, locked: false, wrongTries: 0, waitUntil: 0 }));
    }
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
    ...usablePrompts.map((p) => ({
      id: `prompt-${p.id}`,
      group: "Prompts",
      label: p.name,
      run: () => {
        applyPrompt(p.id);
      },
    })),
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
  if (lock.locked) {
    return (
      <LockScreen
        onUnlock={unlock}
        waitUntil={lock.waitUntil}
        {...(lock.helloAvailable && lock.helloOn ? { onHello: unlockWithHello } : {})}
      />
    );
  }

  return (
    <Tooltip.Provider>
      {/* The desktop window is at least 640 wide; a phone's browser can be narrower (M10). */}
      <div className="flex h-dvh min-h-[480px] flex-col overflow-hidden bg-background text-foreground sm:min-w-[640px]">
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
        {capStates
          .filter((s) => s.over && !s.raised)
          .map((s) => (
            <div
              key={s.provider}
              aria-label="Spend cap notice"
              className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs"
            >
              <CircleAlert className="size-3.5 text-amber-600" />
              <span className="flex-1">
                {providerName(s.provider)} has reached its{" "}
                {s.over === "day"
                  ? `daily cap (${money(s.spentToday)} of ${money(s.cap.dailyMicro ?? 0)})`
                  : `monthly cap (${money(s.spentMonth)} of ${money(s.cap.monthlyMicro ?? 0)})`}
                . FUSE makes no more calls on that key.
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  raiseCap(s.provider);
                }}
              >
                Raise for today
              </Button>
            </div>
          ))}
        {!suggestionNoticeOff && ruleSuggestions[0] && (
          <div
            aria-label="Routing suggestion"
            className="flex items-center gap-2 border-b border-sky-500/30 bg-sky-500/10 px-4 py-2 text-xs"
          >
            <Sparkles className="size-3.5 text-sky-600" />
            <span className="flex-1">
              From your overrides, a routing rule to consider: {ruleSuggestions[0].text}.
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSuggestionNoticeOff(true);
                setView("settings");
              }}
            >
              See it
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss routing suggestion"
              onClick={() => {
                setSuggestionNoticeOff(true);
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
              {...(webApp ? { onRuns: openRuns, runsBadge } : {})}
            />
          )}
          {view === "runs" ? (
            <RunsScreen
              rows={
                serverRuns
                  ? serverRuns.recent.map((r) => runListRow(r, serverRuns.waiting.has(r.id)))
                  : null
              }
              onOpen={select}
              onBack={() => {
                setView("chat");
              }}
            />
          ) : view === "usage" ? (
            <UsageScreen
              view={usageView}
              savings={savings}
              economics={economicsView}
              onFreezeBaseline={() => {
                loadEconomics(Date.now(), true).catch(report);
              }}
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
              web={webApp}
              {...(server ? { server } : {})}
              keys={keys.keys}
              version={appUpdate.version}
              onCheckUpdates={async () => {
                const r = await appUpdate.checkNow();
                return r.kind === "current"
                  ? "FUSE is up to date."
                  : r.kind === "ready"
                    ? `FUSE ${r.version} is ready: restart from the bar at the top.`
                    : `Couldn't check: ${r.message}`;
              }}
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
                  web={webApp}
                  enabled={Boolean(lock.hash)}
                  idleMinutes={lock.idleMinutes}
                  {...(lock.helloAvailable
                    ? {
                        hello: lock.helloOn,
                        onHello: (on: boolean) => {
                          setLock((l) => ({ ...l, helloOn: on }));
                          setSetting(db, tenant, HELLO_SETTING, on ? "on" : "").catch(report);
                        },
                      }
                    : {})}
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
              agent={
                <>
                  <AgentAuditSection
                    rows={audit.map(auditRow)}
                    {...(exporter
                      ? {
                          onExport: (format: "csv" | "json") => {
                            const day = new Date().toISOString().slice(0, 10);
                            const text = format === "csv" ? auditCsv(audit) : auditJson(audit);
                            exporter
                              .save(
                                `fuse-activity-${day}.${format}`,
                                new TextEncoder().encode(text),
                              )
                              .catch(report);
                          },
                        }
                      : {})}
                  />
                  {windowsSandbox && execApi?.windowsSandbox && (
                    <WindowsSandboxSection
                      on={windowsSandbox.on}
                      onToggle={(on) => {
                        const api = execApi.windowsSandbox;
                        if (!api) return;
                        setWindowsSandbox({ on });
                        api
                          .set(on)
                          .then(() =>
                            setSetting(db, tenant, WINDOWS_SANDBOX_SETTING, on ? "on" : "off"),
                          )
                          .catch(report);
                      }}
                      onReset={async () => {
                        try {
                          const n = (await execApi.windowsSandbox?.reset()) ?? 0;
                          return n === 1 ? "Put back 1 folder." : `Put back ${String(n)} folders.`;
                        } catch (e) {
                          return e instanceof Error ? e.message : String(e);
                        }
                      }}
                    />
                  )}
                  {webApp && (
                    <WindowsSandboxSection
                      web
                      on
                      onToggle={() => undefined}
                      onReset={() => Promise.resolve("")}
                    />
                  )}
                </>
              }
              privacy={
                <PrivacySection
                  providers={(["anthropic", "openai"] as const).map((id) => ({
                    id,
                    name: providerName(id),
                    allowed:
                      egressRules.find((r) => r.projectId === null && r.provider === id)?.allow ??
                      true,
                  }))}
                  onProvider={(provider, allow) => {
                    // Allowed is the default: no rule at all.
                    setEgressRule(db, tenant, null, provider, allow ? null : false)
                      .then(refreshProjects)
                      .catch(report);
                  }}
                />
              }
              data={
                exporter && (
                  <DataSection
                    {...(backups ? { backups } : {})}
                    {...(webApp ? { backupRestoreReason: WEB_REASONS.restore } : {})}
                    restore={{
                      read: async (file) => {
                        const parsed = await readFuseExport(
                          new Uint8Array(await file.arrayBuffer()),
                        );
                        restoring.current = parsed;
                        const when = parsed.exportedAt
                          ? new Date(parsed.exportedAt).toLocaleDateString(undefined, {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })
                          : "an unknown date";
                        const what =
                          parsed.scope.kind === "project"
                            ? `the project ${parsed.scope.name}`
                            : "everything";
                        return {
                          title: `An export of ${what} from ${when}, with ${String(parsed.files.size)} files.`,
                          projects: parsed.scope.kind === "all" ? parsed.projects : [],
                          counts: async (projectId) =>
                            restoreLines(
                              await planRestore(
                                db,
                                projectId ? onlyProject(parsed, projectId) : parsed,
                              ),
                            ),
                        };
                      },
                      apply: async (projectId) => {
                        const parsed = restoring.current;
                        if (!parsed) throw new Error("Choose an export first.");
                        const r = await applyRestore(
                          db,
                          tenant,
                          projectId ? onlyProject(parsed, projectId) : parsed,
                          filesApi,
                        );
                        restoring.current = null;
                        await Promise.all([refreshThreads(), refreshProjects(), refreshMemory()]);
                        return `Restored ${String(r.added)} records and ${String(r.files)} files${r.skipped ? `; ${String(r.skipped)} were already here or couldn't be linked` : ""}.`;
                      },
                    }}
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
                webApp ? (
                  <QuickCaptureSection
                    web
                    shortcut={null}
                    mayNotWork={false}
                    error={null}
                    onSave={() => undefined}
                  />
                ) : (
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
                )
              }
              mcp={
                mcpApi && (
                  <McpServersSection
                    {...(webApp ? { signInReason: WEB_REASONS.mcpSignIn } : {})}
                    servers={mcpServers.map((s) => {
                      const health = mcpHealth[s.id];
                      return health ? { ...s, health } : s;
                    })}
                    onAdd={addMcp}
                    {...(mcpApi.check
                      ? {
                          onCheck: (id: string) => {
                            setMcpHealth((h) => ({ ...h, [id]: "checking" }));
                            mcpApi.check?.(id).then(
                              (r) => {
                                setMcpHealth((h) => ({
                                  ...h,
                                  [id]: {
                                    server: `${r.serverName || "a server"}${r.serverVersion ? ` ${r.serverVersion}` : ""}`,
                                    tools: r.tools.map((t) => ({
                                      name: t.name,
                                      kind: t.readOnly ? "Reads" : "Writes",
                                      description: t.description,
                                    })),
                                  },
                                }));
                              },
                              (e: unknown) => {
                                setMcpHealth((h) => ({ ...h, [id]: { error: String(e) } }));
                              },
                            );
                          },
                        }
                      : {})}
                    onRemove={(id) => {
                      const server = mcpServers.find((s) => s.id === id);
                      Promise.all(
                        (server?.variables ?? []).map((v) => mcpApi.removeSecret(id, v.name)),
                      )
                        .then(() => (server?.signedIn ? mcpApi.signOut?.(id) : undefined))
                        .then(() => mcpApi.stop?.(id))
                        .then(() => removeMcpServer(db, tenant, id))
                        .then(refreshMcp)
                        .catch(report);
                    }}
                    {...(mcpApi.signIn && mcpApi.signOut
                      ? {
                          onSignIn: (id: string) => {
                            setMcpHealth((h) => ({ ...h, [id]: "checking" }));
                            mcpApi
                              .signIn?.(id)
                              .then(refreshMcp)
                              .then(() => {
                                setMcpHealth((h) => {
                                  const { [id]: _done, ...rest } = h;
                                  return rest;
                                });
                              })
                              .catch((e: unknown) => {
                                setMcpHealth((h) => ({ ...h, [id]: { error: String(e) } }));
                              });
                          },
                          onSignOut: (id: string) => {
                            mcpApi.signOut?.(id).then(refreshMcp).catch(report);
                          },
                        }
                      : {})}
                    onNetwork={(id, on) => {
                      setMcpServerNetwork(db, tenant, id, on).then(refreshMcp).catch(report);
                    }}
                  />
                )
              }
              python={
                pythonApi && (
                  <PythonRuntimeSection
                    view={{
                      offer: ((pin) =>
                        pin
                          ? {
                              python: pin.python,
                              downloadMb: Math.round(pin.sizeBytes / 1e6),
                              libraries: ["pandas", "numpy", "matplotlib", "openpyxl"],
                            }
                          : null)(pythonPin(thisPlatform())),
                      installed: pyRuntime
                        ? {
                            python: pyRuntime.python,
                            sizeMb: Math.round(pyRuntime.sizeBytes / 1e6),
                            libraries: pyRuntime.packages.length,
                          }
                        : null,
                      job: pyJob,
                      error: pyError,
                    }}
                    onInstall={installPython}
                    onStop={() => {
                      pythonApi.cancel().catch(report);
                    }}
                    onRemove={() => {
                      setPyError(null);
                      pythonApi
                        .remove()
                        .then(() => {
                          setPyRuntime(null);
                        })
                        .catch((e: unknown) => {
                          setPyError(String(e));
                        });
                    }}
                  />
                )
              }
              local={
                webApp ? (
                  <LocalModelSection view={null} web />
                ) : (
                  localApi && (
                    <LocalModelSection
                      view={localModelView(
                        localHardware,
                        localInstalled,
                        localJob,
                        localInstallError,
                      )}
                      error={localError}
                      onInstall={() => {
                        const choice =
                          localHardware && pickProfile(localHardware, localModels.profiles);
                        if (choice?.profile) installLocal(choice.profile);
                      }}
                      onPause={() => {
                        localApi.cancelInstall().catch(report);
                      }}
                      enabled={localOn}
                      shadow={
                        shadow && shadow.checks > 0
                          ? `Shadow checks: ${String(shadow.checks)}, the same answer as the cloud model in ${String(Math.round((shadow.same / shadow.checks) * 100))}%. Median time ${((shadow.localP50 ?? 0) / 1000).toFixed(1)} s here, ${((shadow.cloudP50 ?? 0) / 1000).toFixed(1)} s in the cloud.`
                          : shadowRate > 0
                            ? "Shadow checks are on for its first week: about 1 in 10 of its jobs also runs on a cheap cloud model to compare (timings and agreement only, never the text)."
                            : null
                      }
                      onEnabled={(on) => {
                        setLocalOn(on);
                        setSetting(db, tenant, "local.enabled", on ? "on" : "off").catch(report);
                      }}
                      onRemove={(file) => {
                        setLocalInstallError(null);
                        localApi
                          .remove(file)
                          .then(() => refreshLocalInstalled())
                          .catch(report);
                      }}
                    />
                  )
                )
              }
              keyCaps={
                <KeyCapsSection
                  caps={capStates.map((s) => ({
                    provider: s.provider,
                    name: providerName(s.provider),
                    daily: s.cap.dailyMicro === undefined ? null : s.cap.dailyMicro / 1_000_000,
                    monthly:
                      s.cap.monthlyMicro === undefined ? null : s.cap.monthlyMicro / 1_000_000,
                    spentToday: s.spentToday,
                    spentMonth: s.spentMonth,
                    stopped: s.raised ? null : s.over,
                    raised: s.raised,
                  }))}
                  onSave={(provider, daily, monthly) => {
                    const next: KeyCaps = {
                      ...caps,
                      [provider]: {
                        ...(daily === null ? {} : { dailyMicro: Math.round(daily * 1_000_000) }),
                        ...(monthly === null
                          ? {}
                          : { monthlyMicro: Math.round(monthly * 1_000_000) }),
                      },
                    };
                    setCaps(next);
                    setSetting(db, tenant, CAPS_SETTING, JSON.stringify(next)).catch(report);
                  }}
                  onRaise={raiseCap}
                />
              }
              modelDefaults={
                <ModelDefaultsSection
                  scopes={[
                    ...policy.tiers
                      .filter((t) => t.id !== "cheap")
                      .map((t) => ({
                        key: tierKey(t.id),
                        label: `${t.label} tier`,
                        group: "Tiers",
                      })),
                    ...catalog.models.map((m) => ({
                      key: modelDefaultsKey(m.provider, m.id),
                      label: m.displayName,
                      group: "Models",
                    })),
                    ...projects.map((p) => ({
                      key: projectKey(p.id),
                      label: `Project: ${p.name}`,
                      group: "Projects",
                    })),
                  ]}
                  values={modelDefaults}
                  onSave={(key, value) => {
                    const next = Object.fromEntries(
                      Object.entries(modelDefaults).filter(([k]) => k !== key),
                    );
                    if (value) next[key] = value;
                    setModelDefaults(next);
                    setSetting(db, tenant, DEFAULTS_SETTING, JSON.stringify(next)).catch(report);
                  }}
                />
              }
              prompts={
                <PromptsSection
                  prompts={prompts}
                  projects={projects}
                  onSave={(prompt) => {
                    savePrompt(db, tenant, prompt).then(refreshPrompts).catch(report);
                  }}
                  onDelete={(id) => {
                    deletePrompt(db, tenant, id).then(refreshPrompts).catch(report);
                  }}
                />
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
                    suggestions={ruleSuggestions}
                    onDismissSuggestion={dismissSuggestion}
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
                  currentChat={thread ? { id: thread.id, title: thread.title } : null}
                  onExclude={(id, excluded) => {
                    setMemoryExcluded(db, tenant, id, excluded).then(refreshMemory).catch(report);
                  }}
                  replaced={replaced}
                  onRestore={(id) => {
                    restoreMemory(db, tenant, id).then(refreshMemory).catch(report);
                  }}
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
                        onExport={(format) => {
                          exportThread(format).catch(report);
                        }}
                        stay={{
                          provider: thread.stayProvider ?? stayOn ?? null,
                          on: thread.stayProvider !== null,
                          onToggle: () => {
                            setThreadStay(
                              db,
                              tenant,
                              thread.id,
                              thread.stayProvider ? null : (stayOn ?? null),
                            )
                              .then(refreshThreads)
                              .catch(report);
                          },
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
                    onSideBySide={setSideBySide}
                    onOpenFile={(id) => {
                      openFile(id).catch(report);
                    }}
                    onOpenSource={(chunkId) => {
                      openSource(chunkId).catch(report);
                    }}
                    onContinueRun={continueRunHere}
                    onApprove={(runId, answer) => {
                      approvals.get(runId)?.answer(answer);
                    }}
                    onPreviewChange={(changeId) => {
                      previewChange(changeId).catch(report);
                    }}
                    onUndoChange={(changeId) => {
                      if (!repoApi || !selectedId) return;
                      const threadId = selectedId;
                      undoChange(runDeps(repoApi), changeId)
                        .catch((e: unknown) => {
                          setProblem(e instanceof Error ? e.message : String(e));
                        })
                        .finally(() => void reload(threadId).catch(report));
                    }}
                    onUndoRun={(runId) => {
                      if (!repoApi || !selectedId) return;
                      const threadId = selectedId;
                      undoRun(runDeps(repoApi), runId)
                        .catch((e: unknown) => {
                          setProblem(e instanceof Error ? e.message : String(e));
                        })
                        .finally(() => void reload(threadId).catch(report));
                    }}
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
                    prompts={usablePrompts}
                    onPickPrompt={applyPrompt}
                    compare={{
                      options: compareOptions,
                      selected: compareKeys,
                      onChange: setCompareKeys,
                      estimate: compareEstimate,
                    }}
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
                    onAttachmentSecrets={(id, action) => {
                      attachments.resolveSecrets(id, action).catch(report);
                    }}
                    {...(web ? { onAddLink: attachments.addLink } : {})}
                    webSearch={model.capabilities.includes("web_search") ? searchOn : null}
                    onToggleWebSearch={toggleSearch}
                    {...(repoApi
                      ? {
                          folders: chatFolders.map((f) => ({
                            id: f.id,
                            name: folderName(f.path),
                            path: f.path,
                            own: chatOwnFolders.some((o) => o.id === f.id),
                          })),
                          onAddFolder: addChatFolder,
                          onRemoveFolder: removeChatFolder,
                        }
                      : {})}
                    {...(codeAvailable
                      ? {
                          codeMode: codeMode[codeKey] ?? activeProject?.runMode ?? "ask",
                          onCodeMode: (m: RunMode) => {
                            setCodeMode((all) => ({ ...all, [codeKey]: m }));
                          },
                          codeBranch: codeBranch[codeKey] ?? false,
                          onCodeBranch: (on: boolean) => {
                            setCodeBranch((all) => ({ ...all, [codeKey]: on }));
                          },
                          code: runKind === "code",
                          onToggleCode: () => {
                            setCodeOn((all) => ({
                              ...all,
                              [codeKey]: runKind === "code" ? false : "code",
                            }));
                          },
                          work: runKind === "work",
                          onToggleWork: () => {
                            setCodeOn((all) => ({
                              ...all,
                              [codeKey]: runKind === "work" ? false : "work",
                            }));
                          },
                        }
                      : {})}
                  />
                </div>
                {viewer && (
                  <FileViewer
                    file={viewer}
                    onClose={() => {
                      if (viewer.url) URL.revokeObjectURL(viewer.url);
                      setViewer(null);
                    }}
                  />
                )}
                {!viewer && panelArtifact && (
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
          onAttach={attachArtifact}
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
          {...(editedProject
            ? {
                schedules: (
                  <ScheduledTasksSection
                    web={webApp}
                    tasks={schedules}
                    models={options}
                    defaults={scheduleDefaults()}
                    timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
                    onSave={async (id, draft) => {
                      const input = { ...draft, projectId: editedProject.id };
                      try {
                        if (id) await updateSchedule(db, tenant, id, input);
                        else await createSchedule(db, tenant, input);
                      } catch (e) {
                        return e instanceof Error ? e.message : String(e);
                      }
                      await refreshSchedules();
                      return null;
                    }}
                    onToggle={(id, on) => {
                      setScheduleEnabled(db, tenant, id, on).then(refreshSchedules).catch(report);
                    }}
                    onDelete={(id) => {
                      deleteSchedule(db, tenant, id).then(refreshSchedules).catch(report);
                    }}
                    onOpenChat={(threadId) => {
                      setProjectDialog(null);
                      select(threadId);
                    }}
                  />
                ),
                ...(exporter
                  ? {
                      onExport: async () => {
                        const out = await exportData(db, tenant, filesApi, {
                          kind: "project",
                          projectId: editedProject.id,
                        });
                        const day = new Date().toISOString().slice(0, 10);
                        const name = `fuse-project-${exportName(editedProject.name)}-${day}.zip`;
                        const saved = await exporter.save(name, out.bytes);
                        return saved
                          ? `Saved ${saved}: ${String(out.chats)} chats, ${String(out.files)} files.`
                          : null;
                      },
                    }
                  : {}),
                ...(repoApi
                  ? {
                      tools: {
                        tools: TOOLS.map((t) => ({
                          name: t.spec.name,
                          kind: KIND_LABEL[t.kind],
                          where: placesLabel(t.places),
                          on: !toolsOff.has(t.spec.name),
                          core: t.core === true,
                        })),
                        onSwitch: (name: string, on: boolean) => {
                          switchProjectTool(db, tenant, editedProject.id, name, on)
                            .then(() => projectToolsOff(db, tenant, editedProject.id))
                            .then(setToolsOff)
                            .catch(report);
                        },
                        servers: mcpServers.map((s) => ({
                          id: s.id,
                          name: s.name,
                          on: projectServers.has(s.id),
                        })),
                        onServer: (id: string, on: boolean) => {
                          setProjectMcpServer(db, tenant, editedProject.id, id, on)
                            .then(() => listProjectMcpServers(db, tenant, editedProject.id))
                            .then((l) => {
                              setProjectServers(new Set(l.map((s) => s.id)));
                            })
                            .catch(report);
                        },
                      },
                      repo: {
                        folders: (projectFolderMap[editedProject.id] ?? []).map((f) => ({
                          id: f.id,
                          path: f.path,
                          readSecrets: f.readSecrets,
                          network: netFolders.has(f.id),
                        })),
                        onNetwork: (folderId: string, allow: boolean) => {
                          (allow ? allowNetwork : disallowNetwork)(db, tenant, {
                            kind: "folder",
                            id: folderId,
                          })
                            .then(() => networkFolders(db, tenant))
                            .then(setNetFolders)
                            .catch(report);
                        },
                        onRunMode: (mode: RunMode) => {
                          setProjectRunMode(db, tenant, editedProject.id, mode)
                            .then(refreshProjects)
                            .catch(report);
                        },
                        commands: allowedCommands,
                        onDisallow: (command: string) => {
                          disallowCommand(db, tenant, editedProject.id, command)
                            .then(() => listAllowedCommands(db, tenant, editedProject.id))
                            .then(setAllowedCommands)
                            .catch(report);
                        },
                        note: repoNote,
                        onAdd: () => {
                          pickFolder(repoApi)
                            .then(async (info) => {
                              if (!info) return;
                              const folder = await grantFolder(db, tenant, info.root);
                              await linkProjectFolder(db, tenant, editedProject.id, folder.id);
                              setRepoNote(
                                info.isGit
                                  ? `${info.name}: a git repository.`
                                  : `${info.name}: not a git repository, so git steps won't work there.`,
                              );
                              await loadProjectFolders(editedProject.id);
                              await refreshProjects();
                              await syncFolders(editedProject.id, true);
                            })
                            .catch((e: unknown) => {
                              setRepoNote(e instanceof Error ? e.message : String(e));
                            });
                        },
                        onRemove: (folderId: string) => {
                          setRepoNote(null);
                          unlinkProjectFolder(db, tenant, editedProject.id, folderId)
                            .then(() => loadProjectFolders(editedProject.id))
                            .then(refreshProjects)
                            .then(() => syncFolders(editedProject.id, true))
                            .catch(report);
                        },
                        onReadSecrets: (folderId: string, allow: boolean) => {
                          const f = projectFolderMap[editedProject.id]?.find(
                            (x) => x.id === folderId,
                          );
                          if (!f) return;
                          grantFolder(db, tenant, f.path, allow)
                            .then(() => loadProjectFolders(editedProject.id))
                            .then(refreshProjects)
                            .catch(report);
                        },
                      },
                    }
                  : {}),
                privacy: {
                  mode: editedProject.privacyMode,
                  allowEmbeddings: editedProject.allowEmbeddings,
                  providers: (["anthropic", "openai"] as const).map((id) => ({
                    id,
                    name: providerName(id),
                    own:
                      egressRules.find((r) => r.projectId === editedProject.id && r.provider === id)
                        ?.allow ?? null,
                    global:
                      egressRules.find((r) => r.projectId === null && r.provider === id)?.allow ??
                      true,
                  })),
                  onChange: (change: { mode: PrivacyModeView; allowEmbeddings: boolean }) => {
                    setProjectPrivacy(db, tenant, editedProject.id, change)
                      .then(refreshProjects)
                      .catch(report);
                  },
                  onProvider: (provider: ProviderId, allow: boolean | null) => {
                    setEgressRule(db, tenant, editedProject.id, provider, allow)
                      .then(refreshProjects)
                      .catch(report);
                  },
                  answerWithoutModel: editedProject.answerWithoutModel,
                  onAnswerWithoutModel: (on: boolean) => {
                    setProjectAnswerWithoutModel(db, tenant, editedProject.id, on)
                      .then(refreshProjects)
                      .catch(report);
                  },
                },
                tasks: {
                  tasks: taskViews,
                  onAdd: (text: string) => {
                    if (!taskProblem(text)) {
                      changeTasks((projectId) => addTask(db, tenant, projectId, text));
                    }
                  },
                  onStatus: (id: string, status: TaskStatusView) => {
                    changeTasks(() => setTaskStatus(db, tenant, id, status));
                  },
                  onEdit: (id: string, text: string, dependsOn: string[]) => {
                    if (taskProblem(text)) return;
                    changeTasks(async () => {
                      await renameTask(db, tenant, id, text);
                      await setTaskDependsOn(db, tenant, id, dependsOn);
                    });
                  },
                  onDelete: (id: string) => {
                    changeTasks(() => deleteMemory(db, tenant, id));
                  },
                },
                decisions: {
                  decisions: decisionViews,
                  onAdd: (d: DecisionInputView, replacesId?: string) => {
                    const secret = findSecret(`${d.text}\n${d.rationale}`);
                    if (secret) {
                      setProblem(
                        `That looks like ${SECRET_LABELS[secret]}. Memory never stores those.`,
                      );
                      return;
                    }
                    changeDecisions((projectId) =>
                      addDecision(db, tenant, projectId, d, replacesId),
                    );
                  },
                  onEdit: (id: string, d: DecisionInputView) => {
                    const secret = findSecret(`${d.text}\n${d.rationale}`);
                    if (secret) {
                      setProblem(
                        `That looks like ${SECRET_LABELS[secret]}. Memory never stores those.`,
                      );
                      return;
                    }
                    changeDecisions(() => editDecision(db, tenant, id, d));
                  },
                  onDelete: (id: string) => {
                    changeDecisions(() => deleteMemory(db, tenant, id));
                  },
                },
                artifacts: projectArts.map((a) => ({
                  id: a.id,
                  title: a.title,
                  chat: a.threadTitle,
                })),
                onOpenArtifact: (id: string) => {
                  const a = projectArts.find((x) => x.id === id);
                  if (!a) return;
                  setProjectDialog(null);
                  select(a.threadId);
                  showArtifact(a.key);
                },
              }
            : {})}
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
                  onMaySend: (fileId: string, maySend: boolean) => {
                    const projectId = editedProject.id;
                    setFileMaySend(db, tenant, fileId, maySend)
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
          onReplace={replaceWithProposal}
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
        {filling && (
          <FillPromptDialog
            name={filling.name}
            variables={promptVariables(filling.body)}
            onCancel={() => {
              setFilling(null);
            }}
            onFill={(values) => {
              const text = fillPrompt(filling.body, values);
              setFilling(null);
              setView("chat");
              setQuote((q) => ({ text, key: (q?.key ?? 0) + 1 }));
            }}
          />
        )}
        {sideBySideAnswers && sideBySideAnswers.length >= 2 && (
          <SideBySide
            answers={sideBySideAnswers}
            onClose={() => {
              setSideBySide(null);
            }}
            onKeep={(id) => {
              const threadId = selectedId;
              setSideBySide(null);
              if (!threadId) return;
              setActiveLeaf(db, tenant, threadId, leafUnder(threadAll, id))
                .then(() => reload(threadId))
                .catch(report);
            }}
          />
        )}
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
        {webApp && repoApi && (
          <WebFolderDialog
            open={folderAsk !== null}
            check={(path) => repoApi.check(path)}
            onDone={(info) => {
              folderAsk?.(info);
              setFolderAsk(null);
            }}
          />
        )}
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
