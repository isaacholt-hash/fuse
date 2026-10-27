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
