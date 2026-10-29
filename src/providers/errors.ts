export type ProviderErrorKind =
  | "auth" // bad or missing key
  | "billing" // spend cap, quota, credits: user must act
  | "rate_limit"
  | "overloaded"
  | "server"
  | "network"
  | "invalid_request"
  | "not_found"
  | "stream" // error after the stream started
  | "aborted"
  | "blocked"; // the egress policy (SE-13) refused it before anything was sent

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  "rate_limit",
  "overloaded",
  "server",
  "network",
]);

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | null;
  readonly providerRequestId: string | null;
  /** Seconds, from the retry-after header. */
  readonly retryAfter: number | null;
  /** Provider's own error type/code, for the request log. */
  readonly code: string | null;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    extra: {
      status?: number | null;
      providerRequestId?: string | null;
      retryAfter?: number | null;
      code?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = extra.status ?? null;
    this.providerRequestId = extra.providerRequestId ?? null;
    this.retryAfter = extra.retryAfter ?? null;
    this.code = extra.code ?? null;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/** Plain-English message for the UI (CH: "clear error messages"). */
export function userMessage(e: ProviderError, providerName: string): string {
  switch (e.kind) {
    case "auth":
      if (e.code === "no_key") return `No ${providerName} key yet. Add one in Settings.`;
      if (e.code === "keychain") return "Couldn't read the key from the OS keychain.";
      return `${providerName} rejected the API key. Check it in Settings.`;
    case "billing":
      return `${providerName} says your account is out of credit or over a spend limit.`;
    case "rate_limit":
      return `${providerName} rate limit hit. Try again in a moment.`;
    case "overloaded":
      return `${providerName} is overloaded right now. Try again in a moment.`;
    case "server":
      return `${providerName} had a server error.`;
    case "network":
      return `Couldn't reach ${providerName}. Check your connection.`;
    case "not_found":
      return `${providerName} doesn't recognise that model.`;
    case "invalid_request":
      return `${providerName} rejected the request: ${e.message}`;
    case "stream":
      return `The answer was cut off: ${e.message}`;
    case "aborted":
      return "Stopped.";
    case "blocked":
      return e.message;
  }
}

/** Errors raised by FUSE's own transport before a request reached the provider. */
export function transportError(res: Response): ProviderError | null {
  const code = res.headers.get("x-fuse-error");
  if (!code) return null;
  if (code === "egress") {
    // SE-13: the Rust transport refused it under the egress policy; nothing was sent.
    const reason = decodeURIComponent(res.headers.get("x-fuse-message") ?? "");
    return new ProviderError("blocked", reason || "Blocked by your privacy settings.", {
      status: res.status,
      code,
    });
  }
  const kind: ProviderErrorKind = code === "forbidden" ? "invalid_request" : "auth";
  return new ProviderError(kind, `FUSE: ${code}`, { status: res.status, code });
}

export function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, (date - Date.now()) / 1000);
}
