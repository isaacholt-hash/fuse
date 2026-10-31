// View models for the presentational components. Built from storage/catalog in src/app/viewModels.ts.
import type { CloudProviderId, ProviderId } from "@/catalog/catalog";

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
  /** Large text files (FK-03): sent whole or searched; `canWhole` false past the whole limit. */
  mode?: "whole" | "retrieval";
  canWhole?: boolean;
  /** FK-11: "Looks like it holds an API key (2 lines)"; `canRemove` for text files. */
  secrets?: { summary: string; canRemove: boolean };
}

export interface MessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "streaming" | "stopped" | "error";
  providerName?: string;
  /** Model display name. */
  model?: string;
  /** LL-01: answered by this fixed rule (e.g. "Arithmetic"), with no model, at $0. */
  noModel?: string;
  /** LL-06: reused from the cache at $0; the model that first wrote it. */
  cachedFrom?: string;
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
  /** Saved memories that were sent with this answer (PM-04), and why each went (PM-17). */
  memories?: { text: string; why: string }[];
  /** How the model was picked (RT-09); absent on answers from before routing. */
  route?: RouteView;
  /** The tier "Try a stronger model" would use (e.g. "Best"); only on the latest answer. */
  escalateTo?: string;
  /** Thumbs up or down (CH-07). */
  feedback?: "up" | "down" | null;
  /** This message's place among its siblings, when an edit or regenerate made some (CH-04). */
  branch?: { position: number; total: number };
  /** The messages above go to the model as a summary (PM-06). */
  summaryAbove?: boolean;
  /** Parts of attached files this answer was given, e.g. "book.txt, lines 120–140" (FK-02). */
  fileSources?: { label: string; chunkId: string | null }[];
  /** The coding run this answer is (M6). */
  run?: RunView;
  /** The answer split around its artifacts (AR-01); absent when it has none. */
  parts?: (
    | { kind: "text"; text: string }
    | {
        kind: "artifact";
        key: string;
        title: string;
        type: "markdown" | "code" | "html" | "svg" | "mermaid" | "react";
        language: string;
        complete: boolean;
      }
  )[];
}

/** A coding run shown on its answer (M6 step 5b). */
export interface RunView {
  id: string;
  /** WF-01: "Coding run" or "Work run". */
  title: string;
  status: "running" | "paused" | "done" | "stopped" | "error";
  /** e.g. "$0.12 of $1.00". */
  costLabel: string;
  /** Why it paused, stopped or failed. */
  note: string | null;
  steps: RunStepView[];
  /** The turn still being written. */
  streaming: string;
  /** "read-only" or "can edit files". */
  modeLabel: string;
  /** The branch it made for itself (CA-05). */
  branch: string | null;
  /** Files the run changed (CA-02), oldest first. */
  changes: RunChangeView[];
  /** F2: "Always allow in this project" is kept per project, so it's offered only in one. */
  inProject?: boolean;
  /** What the run is waiting for your OK on (CA-03, CA-04). */
  approval?: ApprovalView;
  /**
   * M9 step 4: what earlier tool results seemed to ask for. Shown on the approval; while there are
   * any, nothing can be always-allowed.
   */
  approvalFlags?: { source: string; why: string; passage: string }[];
}

export type ApprovalView =
  | {
      kind: "command";
      command: string;
      /** Why it always asks; such commands can't be always-allowed. */
      destructive: string | null;
      /** WF-07: no sandbox on this computer: it runs with your full rights. */
      unsandboxed?: boolean;
    }
  | { kind: "edit"; change: RunChangeView }
  /** WF-07: a sandboxed command seems to need the network. */
  | { kind: "network"; command: string }
  /** M9 step 4: an address that may carry what the run read. */
  | { kind: "fetch"; url: string; why: string }
  /** WF-06: a reorganisation to allow in full, in part, or not at all. */
  | { kind: "organise"; moves: { from: string; to: string }[]; reason: string | null }
  /** `remote`: it leaves this computer (push, pull request). */
  | { kind: "git"; summary: string; remote: boolean };

export interface RunChangeView {
  id: string;
  /** "Edited src/a.ts", "Created …", "Deleted …", "Moved a → b". */
  label: string;
  added: number;
  removed: number;
  lines: { kind: "same" | "add" | "del"; text: string }[];
  undone: boolean;
  /** WF-05: the file is still there to preview (not deleted, not undone). */
  previewable: boolean;
}

export interface RunStepView {
  id: string;
  kind: "note" | "tool";
  /** "Read src/app/tide.ts", or the model's note for a turn. */
  label: string;
  /** A tool's error, first line. */
  error: string | null;
  /** F2: a command's whole result (its output, exit code and sandbox line), opened from its row. */
  output?: string;
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
  /** RT-01: the next pick applies to the next message only. */
  once?: boolean;
  onOnce?: (on: boolean) => void;
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
  /** CH-02 */
  pinned: boolean;
  archived: boolean;
  tags: string[];
}

export type KeyBusy = null | "loading" | "saving" | "testing" | "deleting";

export interface KeyView {
  provider: CloudProviderId;
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
  /** A tier instead of a model (RT-01); null with no model means Auto. */
  defaultTier?: "balanced" | "best" | null;
}

/** Settings → Memory: one saved fact (PM-02, PM-07). */
export type MemoryKindView =
  "fact" | "preference" | "person" | "constraint" | "decision" | "task" | "source";

export interface MemoryView {
  id: string;
  text: string;
  kind: MemoryKindView;
  projectId: string | null;
  projectName: string | null;
  /** Kept for one chat only (PM-13): its id and title. */
  threadId: string | null;
  threadName: string | null;
  /** Title of the chat it came from; null if typed in or the chat is gone. */
  source: string | null;
  /** e.g. "Oct 27" */
  date: string;
  confidence: number;
  /** Provenance (PM-14). */
  authority: "you" | "imported" | "extracted";
  extractionMethod: string;
  extractionModel: string | null;
  status: "active" | "excluded" | "expired";
  sensitivity: "normal" | "sensitive";
  maySend: boolean;
  expiresAt: number | null;
  lastVerifiedAt: number | null;
  revision: number;
}

export interface MemoryForm {
  text: string;
  kind: MemoryKindView;
  projectId: string | null;
  /** Kept for this chat only. */
  threadId?: string | null;
  sensitivity?: "normal" | "sensitive";
  maySend?: boolean;
  expiresAt?: number | null;
}

/** A change the Cheap model suggested, waiting for review (PM-03). */
export interface ProposalView {
  id: string;
  op: "add" | "update" | "delete";
  /** The new text (add, update). */
  text: string;
  /** The saved fact it changes (update, delete). */
  currentText: string | null;
  kind: MemoryKindView;
  projectName: string | null;
  source: string | null;
  confidence: number;
  /** PM-11: a saved fact this new one may contradict (adds only). */
  conflict?: { id: string; text: string };
}

/** PL-10: text size, and reduce motion (follow the OS, or on/off). */
export type TextSize = "small" | "normal" | "large";
export type Motion = "system" | "reduce" | "full";
