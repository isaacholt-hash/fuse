// View models for the presentational components. Built from storage/catalog in src/app/viewModels.ts.
import type { ProviderId } from "@/catalog/catalog";

export type Theme = "light" | "dark" | "system";
export type ThreadGroup = "Today" | "Yesterday" | "Previous 7 days" | "Older";

export interface ModelOption {
  id: string;
  provider: ProviderId;
  providerName: string;
  name: string;
  /** e.g. "200K" */
  context: string;
  /** $ per 1M tokens */
  inputPrice: number;
  outputPrice: number;
}

/** Token counts and integer micro-dollar costs for one answer. */
export interface UsageView {
  /** Input billed at the base rate (excludes cache reads and writes). */
  freshInput: number;
  cachedInput: number;
  cacheWrite: number;
  /** Includes reasoning. */
  output: number;
  reasoning: number;
  webSearchCalls: number;
  /** Per-part costs; null when the price that was used is no longer in the catalog. */
  parts: {
    fresh: number;
    cached: number;
    cacheWrite: number;
    output: number;
    webSearch: number;
  } | null;
  /** Null when the provider reported no usage (cost unknown). */
  totalMicro: number | null;
  latencyMs: number | null;
}

/** A file shown on a question: images get a thumbnail (`url`, a local blob: URL). */
export interface ImageView {
  id: string;
  name: string;
  kind: "image" | "document";
  url: string | null;
}

/** A file waiting in the composer. */
export interface PendingAttachment {
  id: string;
  name: string;
  status: "processing" | "ready" | "error";
  kind?: "image" | "document";
  /** Thumbnail (blob: URL) once processed. */
  url?: string;
  /** Large documents get a warning tone. */
  large?: boolean;
  /** e.g. "1,229 tokens · $0.0025 per turn" */
  detail?: string;
  error?: string;
}

export interface MessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "streaming" | "stopped" | "error";
  providerName?: string;
  /** Model display name. */
  model?: string;
  usage?: UsageView;
  /** Divider shown above this answer when the model changed. */
  switchLabel?: string;
  /** Plain-English error (status "error"). */
  error?: string;
  /** Shown under a complete answer, e.g. "cut off at the output limit". */
  notice?: string;
  /** Images attached to a question. */
  images?: ImageView[];
  /** Web sources the answer cites. */
  sources?: SourceView[];
  /** The provider is searching the web right now. */
  searching?: boolean;
  /** Saved memories that were sent with this answer (PM-04). */
  memories?: string[];
  /** How the model was picked (RT-09); absent on answers from before routing. */
  route?: RouteView;
}

/** The routing badge on an answer. */
export interface RouteView {
  /** e.g. "Auto · Balanced", "Pinned · Best", "Your pick" */
  label: string;
  /** The rule's reason, e.g. "Everyday answers start on Balanced". */
  reason: string;
  /** What the classifier read, e.g. "coding, high" (Auto only). */
  readAs: string | null;
  /** The same tokens on the cheapest Best model; null when this answer was on Best or unknown. */
  bestMicro: number | null;
}

/** A composer mode (RT-01): Auto, or a pinned tier. A pinned model is picked from the model list. */
export type ModeChoice = "auto" | "balanced" | "best";

export interface RoutingView {
  /** The current mode, or null when a model is pinned. */
  selected: ModeChoice | null;
  /** One line under each choice in the picker. */
  descriptions: Record<ModeChoice, string>;
  /** The tier Auto would pick for this draft (e.g. "Best"), or null. Runs as you type. */
  preview: (text: string) => string | null;
  onSelect: (choice: ModeChoice) => void;
}

export interface SourceView {
  url: string;
  title: string | null;
}

export interface ThreadView {
  id: string;
  title: string;
  group: ThreadGroup;
  costMicro: number;
  projectId: string | null;
}

export type KeyBusy = null | "loading" | "saving" | "testing" | "deleting";

export interface KeyView {
  provider: ProviderId;
  name: string;
  consoleUrl: string;
  saved: boolean;
  /** e.g. `sk-…3f9a` */
  masked: string | null;
  busy: KeyBusy;
  /** Outcome of the last save/test. */
  result: { tone: "ok" | "warn" | "error"; text: string } | null;
}

/** One provider call in the request log (step 9). */
export interface RequestRow {
  id: string;
  /** e.g. "14:02:37" or "Oct 26, 14:02" */
  time: string;
  provider: string;
  /** Model display name, or what the call was for (e.g. "Key test"). */
  model: string;
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  /** Integer micro-dollars; null when unknown. */
  cost: number | null;
  latency: string;
  tone: "ok" | "stopped" | "error";
  status: string;
  /** Provider's request id, for support tickets. */
  requestId: string | null;
}

/** Settings → Custom instructions (CH-05). */
export interface GlobalInstructionsView {
  aboutYou: string;
  howToAnswer: string;
}

/** One instruction in effect for a chat, e.g. "About you" and its text. */
export interface InstructionPartView {
  label: string;
  text: string;
}

/** A project in the sidebar, with its chats (most recent first). */
export interface ProjectView {
  id: string;
  name: string;
  threads: ThreadView[];
  costMicro: number;
}

/** The fields of the project dialog. */
export interface ProjectForm {
  name: string;
  instructions: string;
  defaultModel: { provider: ProviderId; id: string } | null;
}

/** Settings → Memory: one saved fact (PM-02, PM-07). */
export type MemoryCategoryView = "fact" | "preference" | "person" | "project";

export interface MemoryView {
  id: string;
  text: string;
  category: MemoryCategoryView;
  projectId: string | null;
  projectName: string | null;
  /** Title of the chat it came from; null if typed in or the chat is gone. */
  source: string | null;
  /** e.g. "Oct 27" */
  date: string;
  confidence: number;
}

export interface MemoryForm {
  text: string;
  category: MemoryCategoryView;
  projectId: string | null;
}

/** A change the Cheap model suggested, waiting for review (PM-03). */
export interface ProposalView {
  id: string;
  op: "add" | "update" | "delete";
  /** The new text (add, update). */
  text: string;
  /** The saved fact it changes (update, delete). */
  currentText: string | null;
  category: MemoryCategoryView;
  projectName: string | null;
  source: string | null;
  confidence: number;
}
