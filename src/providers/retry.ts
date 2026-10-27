import { ProviderError } from "./errors";

export interface RetryOptions {
  /** Retries after the first attempt (docs/providers.md: 3). */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError("aborted", "Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new ProviderError("aborted", "Aborted"));
      },
      { once: true },
    );
  });
}

/**
 * Runs `attempt` until it succeeds, a non-retryable error happens, or retries run out.
 * Waits at least `retry-after` when the provider sends it, else exponential backoff with jitter.
 * Only wrap work that hasn't shown anything to the user yet (the initial request, not the stream).
 */
export async function withRetry<T>(
  attempt: (n: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<{ value: T; attempts: number }> {
  const maxRetries = opts.maxRetries ?? 3;
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? abortableSleep;
  const random = opts.random ?? Math.random;
  for (let n = 1; ; n++) {
    try {
      return { value: await attempt(n), attempts: n };
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError("network", String(e));
      if (!err.retryable || n > maxRetries || opts.signal?.aborted) throw err;
      const backoff = Math.min(max, base * 2 ** (n - 1));
      const jitter = backoff * 0.25 * random();
      const floor = err.retryAfter !== null ? err.retryAfter * 1000 : 0;
      await sleep(Math.max(floor + jitter, backoff + jitter), opts.signal);
    }
  }
}
