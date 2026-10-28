import type { ProviderId } from "@/catalog/catalog";
import type { Usage } from "@/storage/usage";

/**
 * Minimal fetch the adapters need. Injected: on desktop it's the Rust transport (which adds the
 * API key), in tests it serves recorded fixtures, on the P2 server it's Node fetch plus auth.
 * Adapters never see or send API keys.
 */
export type FetchLike = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

/** An image sent with a user message, base64-encoded (no data: prefix). */
export interface ImageAttachment {
  kind: "image";
  mediaType: string;
  data: string;
}
/** A PDF, base64-encoded; both providers read its text and page images. */
export interface PdfAttachment {
  kind: "pdf";
  name: string;
  data: string;
}
/** A document already turned into text on this machine (text, code, CSV, Word…). */
export interface TextAttachment {
  kind: "text";
  name: string;
  text: string;
}
export type Attachment = ImageAttachment | PdfAttachment | TextAttachment;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** User messages only; resent with every turn (both APIs are stateless here). */
  attachments?: Attachment[];
}

export interface ChatOptions {
  /** System prompt / instructions. */
  system?: string;
  maxOutputTokens?: number;
  /** Let the model use the provider's web search tool (billed per search). */
  webSearch?: boolean;
  /**
   * Reasoning effort (RT-08), the same five levels on both providers. Omitted = the model's
   * default (docs/providers.md, M2).
   */
  effort?: Effort;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Normalised token counts (no cost: pricing is the chat layer's job, from data/models.json). */
export type TokenUsage = Omit<Usage, "costMicroUsd" | "priceVersion" | "latencyMs" | "ttftMs">;

export interface StreamDone {
  type: "done";
  usage: TokenUsage;
  /** False when the provider sent no usage at all (cost will show as unknown). */
  usageReported: boolean;
  stopReason: string | null;
  providerRequestId: string | null;
  /** HTTP attempts made, 1 = no retries. */
  attempts: number;
}

export type StreamEvent =
  | { type: "text"; text: string }
  /** The provider is running a server tool (e.g. a web search); null when it's done. */
  | { type: "status"; status: "searching" | null }
  /** A source the answer cites. */
  | { type: "citation"; url: string; title: string | null }
  | StreamDone;

export interface RemoteModel {
  id: string;
  displayName: string | null;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  listModels(signal?: AbortSignal): Promise<RemoteModel[]>;
  /** Text deltas, then exactly one `done`. Throws ProviderError on failure. */
  streamChat(
    messages: ChatMessage[],
    model: string,
    options: ChatOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent>;
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
