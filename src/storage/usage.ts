/** Token usage and cost as stored on messages and request_log rows. Money is integer micro-dollars. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Web searches run by the provider for this request (billed per call). */
  webSearchCalls: number;
  costMicroUsd: number;
  priceVersion: string | null;
  latencyMs: number | null;
  ttftMs: number | null;
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  webSearchCalls: 0,
  costMicroUsd: 0,
  priceVersion: null,
  latencyMs: null,
  ttftMs: null,
};

export const USAGE_COLUMNS =
  "input_tokens, output_tokens, cached_input_tokens, cache_write_tokens, reasoning_tokens, web_search_calls, cost_micro_usd, price_version, latency_ms, ttft_ms";

/** One placeholder per USAGE_COLUMNS entry. */
export const USAGE_PLACEHOLDERS = USAGE_COLUMNS.split(",")
  .map(() => "?")
  .join(", ");

export interface UsageRow {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  web_search_calls: number;
  cost_micro_usd: number;
  price_version: string | null;
  latency_ms: number | null;
  ttft_ms: number | null;
}

export function usageValues(u: Usage): (string | number | null)[] {
  return [
    u.inputTokens,
    u.outputTokens,
    u.cachedInputTokens,
    u.cacheWriteTokens,
    u.reasoningTokens,
    u.webSearchCalls,
    u.costMicroUsd,
    u.priceVersion,
    u.latencyMs,
    u.ttftMs,
  ];
}

export function usageFromRow(r: UsageRow): Usage {
  return {
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cachedInputTokens: r.cached_input_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    reasoningTokens: r.reasoning_tokens,
    webSearchCalls: r.web_search_calls,
    costMicroUsd: r.cost_micro_usd,
    priceVersion: r.price_version,
    latencyMs: r.latency_ms,
    ttftMs: r.ttft_ms,
  };
}
