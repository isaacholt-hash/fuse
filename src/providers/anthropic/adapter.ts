// Anthropic Messages API adapter. Facts and decisions: docs/providers.md (verified 2026-10-26).
import { ProviderError, parseRetryAfter, transportError, type ProviderErrorKind } from "../errors";
import { withRetry, type RetryOptions } from "../retry";
import { readSse } from "../sse";
import {
  SCOPE_HEADER,
  scopeValue,
  type SendScope,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type Attachment,
  type ChatMessage,
  type ChatOptions,
  type FetchLike,
  type ProviderAdapter,
  type RemoteModel,
  type StreamEvent,
  type TokenUsage,
} from "../types";

export const ANTHROPIC_API = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2026-10-21";

const baseHeaders = {
  "anthropic-version": ANTHROPIC_VERSION,
  "content-type": "application/json",
};

interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  output_tokens_details?: { thinking_tokens?: number | null } | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

interface AnthropicErrorBody {
  error?: { type?: string; message?: string; details?: { error_code?: string } };
}

/** Pure: `usage` objects seen in the stream, last value per field wins (they're cumulative). */
export function mergeUsage(acc: AnthropicUsage, next: AnthropicUsage | undefined): AnthropicUsage {
  if (!next) return acc;
  const out: AnthropicUsage = { ...acc };
  for (const [k, v] of Object.entries(next) as [keyof AnthropicUsage, unknown][]) {
    if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function normaliseUsage(u: AnthropicUsage): TokenUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    cachedInputTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    reasoningTokens: u.output_tokens_details?.thinking_tokens ?? 0,
    webSearchCalls: u.server_tool_use?.web_search_requests ?? 0,
  };
}

/** Maps an HTTP error response to a ProviderError (docs/providers.md, "Errors and retries"). */
export async function errorFromResponse(res: Response): Promise<ProviderError> {
  const own = transportError(res);
  if (own) return own;
  let body: AnthropicErrorBody = {};
  try {
    body = (await res.json()) as AnthropicErrorBody;
  } catch {
    // non-JSON (e.g. Cloudflare 413 page)
  }
  const type = body.error?.type ?? null;
  const message = body.error?.message ?? `HTTP ${String(res.status)}`;
  const spendCap = body.error?.details?.error_code === "enforced_spend_limit_reached";
  const kind: ProviderErrorKind = (() => {
    if (spendCap || res.status === 402 || type === "billing_error") return "billing";
    switch (res.status) {
      case 401:
      case 403:
        return "auth";
      case 404:
        return "not_found";
      case 429:
        return "rate_limit";
      case 500:
      case 504:
        return "server";
      case 529:
        return "overloaded";
      default:
        return res.status >= 500 ? "server" : "invalid_request";
    }
  })();
  return new ProviderError(kind, message, {
    status: res.status,
    providerRequestId: res.headers.get("request-id"),
    retryAfter: parseRetryAfter(res.headers.get("retry-after")),
    code: body.error?.details?.error_code ?? type,
  });
}

function anthropicBlock(a: Attachment): Record<string, unknown> {
  switch (a.kind) {
    case "image":
      return { type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } };
    case "pdf":
      return {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: a.data },
        title: a.name,
      };
    case "text":
      return {
        type: "document",
        source: { type: "text", media_type: "text/plain", data: a.text },
        title: a.name,
      };
  }
}

/** Plain string, or blocks when the message carries attachments (attachments first, then text). */
function anthropicContent(m: ChatMessage): string | Record<string, unknown>[] {
  if (!m.attachments?.length) return m.content;
  return [
    ...m.attachments.map(anthropicBlock),
    ...(m.content ? [{ type: "text", text: m.content }] : []),
  ];
}

export function buildRequestBody(
  messages: ChatMessage[],
  model: string,
  options: ChatOptions,
): Record<string, unknown> {
  if (messages.at(-1)?.role !== "user") {
    // Claude 4.6+ rejects assistant prefill; fail early with a clear message.
    throw new ProviderError("invalid_request", "The conversation must end with a user message.");
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    stream: true,
    // Automatic prompt caching (RT-07): the cache breakpoint sits on the last cacheable block and
    // moves forward as the thread grows. Prompts under the minimum (512 tokens) just aren't cached.
    cache_control: { type: "ephemeral" },
    messages: messages.map((m) => ({ role: m.role, content: anthropicContent(m) })),
  };
  if (options.system) body.system = options.system;
  // Effort only; never `thinking` (Opus 5.5 rejects "disabled", Sonnet 5.5 too).
  if (options.effort) body.output_config = { effort: options.effort };
  if (options.webSearch) {
    // Basic version: ZDR-eligible and no code execution (docs/providers.md, M1).
    body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
  }
  // Never temperature/top_p/top_k: rejected under anthropic-version 2026-10-21.
  return body;
}

export function createAnthropicAdapter(deps: {
  fetch: FetchLike;
  retry?: Omit<RetryOptions, "signal">;
}): ProviderAdapter {
  const send = async (
    path: string,
    init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal; scope?: SendScope },
  ): Promise<Response> => {
    let res: Response;
    const { scope, ...rest } = init;
    try {
      res = await deps.fetch(`${ANTHROPIC_API}${path}`, {
        ...rest,
        headers: scope ? { ...baseHeaders, [SCOPE_HEADER]: scopeValue(scope) } : baseHeaders,
      });
    } catch (e) {
      if (init.signal?.aborted) throw new ProviderError("aborted", "Aborted");
      throw new ProviderError("network", e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) throw await errorFromResponse(res);
    return res;
  };

  return {
    provider: "anthropic",

    async listModels(signal) {
      const { value: res } = await withRetry(
        () => send("/v1/models?limit=1000", { method: "GET", ...(signal ? { signal } : {}) }),
        { ...deps.retry, ...(signal ? { signal } : {}) },
      );
      const json = (await res.json()) as { data?: { id: string; display_name?: string }[] };
      return (json.data ?? []).map((m): RemoteModel => ({
        id: m.id,
        displayName: m.display_name ?? null,
      }));
    },

    async *streamChat(messages, model, options, signal): AsyncGenerator<StreamEvent> {
      const body = JSON.stringify(buildRequestBody(messages, model, options));
      const { value: res, attempts } = await withRetry(
        () =>
          send("/v1/messages", {
            method: "POST",
            body,
            ...(signal ? { signal } : {}),
            ...(options.scope ? { scope: options.scope } : {}),
          }),
        { ...deps.retry, ...(signal ? { signal } : {}) },
      );
      const requestId = res.headers.get("request-id");
      if (!res.body)
        throw new ProviderError("stream", "Empty response body", { status: res.status });

      let usage: AnthropicUsage = {};
      let usageReported = false;
      let stopReason: string | null = null;
      let stopped = false;
      let searched = false;
      let wroteText = false;
      try {
        for await (const ev of readSse(res.body)) {
          if (signal?.aborted) throw new ProviderError("aborted", "Aborted");
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(ev.data) as Record<string, unknown>;
          } catch {
            continue; // not JSON (shouldn't happen); ignore like an unknown event
          }
          switch (data.type) {
            case "message_start": {
              const m = data.message as { usage?: AnthropicUsage } | undefined;
              if (m?.usage) usageReported = true;
              usage = mergeUsage(usage, m?.usage);
              break;
            }
            case "content_block_start": {
              const block = data.content_block as { type?: string } | undefined;
              if (block?.type === "server_tool_use") {
                searched = true;
                yield { type: "status", status: "searching" };
              } else if (block?.type === "web_search_tool_result") {
                yield { type: "status", status: null };
              } else if (block?.type === "text" && searched && wroteText) {
                // Text written before a search ("I'll look that up.") stays its own paragraph.
                yield { type: "text", text: "\n\n" };
                searched = false;
              }
              break;
            }
            case "content_block_delta": {
              const d = data.delta as
                | {
                    type?: string;
                    text?: string;
                    citation?: { url?: string; title?: string | null };
                  }
                | undefined;
              if (d?.type === "text_delta" && d.text) {
                wroteText = true;
                yield { type: "text", text: d.text };
              } else if (d?.type === "citations_delta" && d.citation?.url) {
                yield { type: "citation", url: d.citation.url, title: d.citation.title ?? null };
              }
              break; // thinking/signature/tool-input deltas aren't shown
            }
            case "message_delta": {
              const d = data.delta as { stop_reason?: string | null } | undefined;
              if (d?.stop_reason) stopReason = d.stop_reason;
              const u = data.usage as AnthropicUsage | undefined;
              if (u) usageReported = true;
              usage = mergeUsage(usage, u);
              break;
            }
            case "message_stop":
              stopped = true;
              break;
            case "error": {
              const err = data.error as { type?: string; message?: string } | undefined;
              throw new ProviderError("stream", err?.message ?? "Stream error", {
                status: res.status,
                providerRequestId: requestId,
                code: err?.type ?? null,
              });
            }
            default:
              break; // ping, content_block_stop, unknown future events
          }
        }
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        if (signal?.aborted) throw new ProviderError("aborted", "Aborted");
        throw new ProviderError("stream", e instanceof Error ? e.message : String(e), {
          providerRequestId: requestId,
        });
      }
      if (!stopped) {
        throw new ProviderError("stream", "The connection closed before the answer finished.", {
          providerRequestId: requestId,
        });
      }
      yield {
        type: "done",
        usage: normaliseUsage(usage),
        usageReported,
        stopReason,
        providerRequestId: requestId,
        attempts,
      };
    },
  };
}
