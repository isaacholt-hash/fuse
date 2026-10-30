// OpenAI Responses API adapter. Facts and decisions: docs/providers.md (verified 2026-10-26).
// Responses over Chat Completions: recommended by OpenAI for new projects, needed for tool calling
// on gpt-6-astra / gpt-6.1-sol, and `store: false` keeps nothing on OpenAI's side.
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
  type ToolCall,
  type ToolSpec,
  type TokenUsage,
} from "../types";

export const OPENAI_API = "https://api.openai.com";

const headers = { "content-type": "application/json" };

/** 429 codes that mean "the user must act" (docs/providers.md). */
const BILLING_CODES = new Set([
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "insufficient_quota",
]);

interface OpenAIUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
}

interface OpenAIErrorBody {
  error?: { message?: string; type?: string; code?: string | null; param?: string | null };
}

/** OpenAI's `input_tokens` includes cache reads and writes; ours counts only base-rate input. */
/** Usage plus searches: OpenAI has no search counter, so count the web_search_call items. */
export function normaliseUsage(u: OpenAIUsage, webSearchCalls = 0): TokenUsage {
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const written = u.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (u.input_tokens ?? 0) - cached - written),
    cachedInputTokens: cached,
    cacheWriteTokens: written,
    outputTokens: u.output_tokens ?? 0,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    webSearchCalls,
  };
}

/** Searches billed for a response: web_search_call items whose action is a search. */
export function countSearches(output: ResponseObject["output"]): number {
  return (output ?? []).filter(
    (item) => item.type === "web_search_call" && (item.action?.type ?? "search") === "search",
  ).length;
}

export async function errorFromResponse(res: Response): Promise<ProviderError> {
  const own = transportError(res);
  if (own) return own;
  let body: OpenAIErrorBody = {};
  try {
    body = (await res.json()) as OpenAIErrorBody;
  } catch {
    // non-JSON body
  }
  const code = body.error?.code ?? null;
  const type = body.error?.type ?? null;
  const message = body.error?.message ?? `HTTP ${String(res.status)}`;
  const kind: ProviderErrorKind = (() => {
    if ((code && BILLING_CODES.has(code)) || type === "insufficient_quota") return "billing";
    switch (res.status) {
      case 401:
      case 403:
        return "auth";
      case 404:
        return "not_found";
      case 429:
        return "rate_limit";
      case 503:
        return "overloaded";
      default:
        return res.status >= 500 ? "server" : "invalid_request";
    }
  })();
  return new ProviderError(kind, message, {
    status: res.status,
    providerRequestId: res.headers.get("x-request-id"),
    retryAfter: parseRetryAfter(res.headers.get("retry-after")),
    code: code ?? type,
  });
}

/**
 * Plain string, or parts when the message carries images. detail "high" caps an image at 2,500
 * patches; "auto" would use the full size (docs/providers.md, M1).
 */
function openaiPart(a: Attachment): Record<string, unknown> {
  switch (a.kind) {
    case "image":
      return {
        type: "input_image",
        image_url: `data:${a.mediaType};base64,${a.data}`,
        detail: "high",
      };
    case "pdf":
      return {
        type: "input_file",
        filename: a.name,
        file_data: `data:application/pdf;base64,${a.data}`,
      };
    case "text":
      return { type: "input_text", text: `<file name="${a.name}">\n${a.text}\n</file>` };
  }
}

function openaiContent(m: ChatMessage): string | Record<string, unknown>[] {
  if (!m.attachments?.length) return m.content;
  return [
    ...m.attachments.map(openaiPart),
    ...(m.content ? [{ type: "input_text", text: m.content }] : []),
  ];
}

/** A tool sent to OpenAI: strict, with the shared schema (docs/providers.md, M6). */
export function openaiTool(t: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.schema,
    strict: true,
  };
}

/** Input items for one message: a tool loop's turn and results are items, not messages. */
function openaiItems(m: ChatMessage, model: string): unknown[] {
  if (m.native) {
    // Reasoning (with encrypted_content), function calls and messages (with phase), unchanged.
    if (m.native.provider !== "openai" || m.native.model !== model) {
      throw new ProviderError("invalid_request", "A tool loop can't move to another model.");
    }
    return m.native.items;
  }
  if (m.toolResults?.length) {
    return [
      ...m.toolResults.map((r) => {
        // No error flag on OpenAI: the text says so (docs/providers.md, M6).
        const text =
          r.isError && !r.content.startsWith("Error:") ? `Error: ${r.content}` : r.content;
        return {
          type: "function_call_output",
          call_id: r.callId,
          // WF-03: with images, the output is a list of input_text and input_image items.
          output: r.images?.length
            ? [
                { type: "input_text", text },
                ...r.images.map((i) => ({
                  type: "input_image",
                  image_url: `data:${i.mime};base64,${i.data}`,
                })),
              ]
            : text,
        };
      }),
      ...(m.content ? [{ role: "user", content: m.content }] : []),
    ];
  }
  return [{ role: m.role, content: openaiContent(m) }];
}

export function buildRequestBody(
  messages: ChatMessage[],
  model: string,
  options: ChatOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    input: messages.flatMap((m) => openaiItems(m, model)),
    stream: true,
    store: false, // defaults to true (30-day retention) if omitted
    service_tier: "default", // Standard pricing, whatever the project setting
    max_output_tokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
  if (options.system) body.instructions = options.system;
  if (options.effort) body.reasoning = { effort: options.effort };
  const tools: Record<string, unknown>[] = (options.tools ?? []).map(openaiTool);
  if (options.webSearch) {
    // An empty approximate location stops OpenAI defaulting results to the US.
    tools.push({ type: "web_search", user_location: { type: "approximate" } });
  }
  if (tools.length) body.tools = tools;
  // Never temperature/top_p: rejected on GPT-6 models unless reasoning effort is "none".
  return body;
}

interface ResponseObject {
  usage?: OpenAIUsage | null;
  output?: { type?: string; action?: { type?: string } | null }[] | null;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
}

export function createOpenAIAdapter(deps: {
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
      res = await deps.fetch(`${OPENAI_API}${path}`, {
        ...rest,
        headers: scope ? { ...headers, [SCOPE_HEADER]: scopeValue(scope) } : headers,
      });
    } catch (e) {
      if (init.signal?.aborted) throw new ProviderError("aborted", "Aborted");
      throw new ProviderError("network", e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) throw await errorFromResponse(res);
    return res;
  };

  return {
    provider: "openai",

    async listModels(signal) {
      const { value: res } = await withRetry(
        () => send("/v1/models", { method: "GET", ...(signal ? { signal } : {}) }),
        { ...deps.retry, ...(signal ? { signal } : {}) },
      );
      const json = (await res.json()) as { data?: { id: string }[] };
      return (json.data ?? []).map((m): RemoteModel => ({ id: m.id, displayName: null }));
    },

    async embed(texts, model, signal, scope) {
      const body = JSON.stringify({ model, input: texts, encoding_format: "float" });
      const { value: res, attempts } = await withRetry(
        () =>
          send("/v1/embeddings", {
            method: "POST",
            body,
            ...(signal ? { signal } : {}),
            ...(scope ? { scope } : {}),
          }),
        { ...deps.retry, ...(signal ? { signal } : {}) },
      );
      const json = (await res.json()) as {
        data?: { index: number; embedding: number[] }[];
        usage?: { prompt_tokens?: number };
      };
      const data = [...(json.data ?? [])].sort((a, b) => a.index - b.index);
      if (data.length !== texts.length) {
        throw new ProviderError(
          "stream",
          `Expected ${String(texts.length)} embeddings, got ${String(data.length)}`,
        );
      }
      return {
        vectors: data.map((d) => Float32Array.from(d.embedding)),
        tokens: json.usage?.prompt_tokens ?? 0,
        providerRequestId: res.headers.get("x-request-id"),
        attempts,
      };
    },

    async *streamChat(messages, model, options, signal): AsyncGenerator<StreamEvent> {
      const body = JSON.stringify(buildRequestBody(messages, model, options));
      const { value: res, attempts } = await withRetry(
        () =>
          send("/v1/responses", {
            method: "POST",
            body,
            ...(signal ? { signal } : {}),
            ...(options.scope ? { scope: options.scope } : {}),
          }),
        { ...deps.retry, ...(signal ? { signal } : {}) },
      );
      const requestId = res.headers.get("x-request-id");
      if (!res.body)
        throw new ProviderError("stream", "Empty response body", { status: res.status });

      let final: { response: ResponseObject; stopReason: string } | null = null;
      // Finished output items, for replay inside a tool loop. Taken from output_item.done:
      // a reasoning item's encrypted_content can be incomplete in output_item.added.
      const items: Record<string, unknown>[] = [];
      try {
        for await (const ev of readSse(res.body)) {
          if (signal?.aborted) throw new ProviderError("aborted", "Aborted");
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(ev.data) as Record<string, unknown>;
          } catch {
            continue; // e.g. a "[DONE]" sentinel
          }
          switch (data.type) {
            case "response.output_text.delta": {
              const delta = data.delta;
              if (typeof delta === "string" && delta) yield { type: "text", text: delta };
              break;
            }
            case "response.web_search_call.in_progress":
            case "response.web_search_call.searching":
              yield { type: "status", status: "searching" };
              break;
            case "response.web_search_call.completed":
              yield { type: "status", status: null };
              break;
            case "response.output_text.annotation.added": {
              const a = data.annotation as
                { type?: string; url?: string; title?: string } | undefined;
              if (a?.type === "url_citation" && a.url) {
                yield { type: "citation", url: a.url, title: a.title ?? null };
              }
              break;
            }
            case "response.output_item.done": {
              const item = data.item as Record<string, unknown> | undefined;
              if (!item) break;
              items.push(item);
              if (item.type === "function_call") {
                const args = typeof item.arguments === "string" ? item.arguments : "";
                const call: ToolCall = {
                  id: String(item.call_id),
                  name: String(item.name),
                  input: args ? (JSON.parse(args) as Record<string, unknown>) : {},
                };
                yield { type: "tool_call", call };
              }
              break;
            }
            case "response.completed":
              final = { response: data.response as ResponseObject, stopReason: "completed" };
              break;
            case "response.incomplete": {
              const r = data.response as ResponseObject;
              final = { response: r, stopReason: r.incomplete_details?.reason ?? "incomplete" };
              break;
            }
            case "response.failed": {
              const r = data.response as ResponseObject;
              throw new ProviderError("stream", r.error?.message ?? "The response failed", {
                status: res.status,
                providerRequestId: requestId,
                code: r.error?.code ?? null,
              });
            }
            case "error":
              throw new ProviderError(
                "stream",
                typeof data.message === "string" ? data.message : "Stream error",
                {
                  status: res.status,
                  providerRequestId: requestId,
                  code: typeof data.code === "string" ? data.code : null,
                },
              );
            default:
              break; // created, in_progress, output_item/content_part events, reasoning, unknown
          }
          if (final) break;
        }
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        if (signal?.aborted) throw new ProviderError("aborted", "Aborted");
        throw new ProviderError("stream", e instanceof Error ? e.message : String(e), {
          providerRequestId: requestId,
        });
      }
      if (!final) {
        throw new ProviderError("stream", "The connection closed before the answer finished.", {
          providerRequestId: requestId,
        });
      }
      const usage = final.response.usage;
      yield {
        type: "done",
        usage: normaliseUsage(usage ?? {}, countSearches(final.response.output)),
        usageReported: Boolean(usage),
        // OpenAI has no "tool_use" stop reason: calls in the output mean the loop goes on.
        stopReason: items.some((i) => i.type === "function_call") ? "tool_use" : final.stopReason,
        providerRequestId: requestId,
        attempts,
        ...(options.tools?.length ? { turn: { provider: "openai" as const, model, items } } : {}),
      };
    },
  };
}
