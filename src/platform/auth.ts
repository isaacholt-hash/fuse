/**
 * Signing in to FUSE on HULK (M10 steps 4 and 5): the web app's passphrase, its session, and the
 * devices paired with the server (src-tauri/src/auth.rs). These are plain requests to
 * `/api/auth/*` at the same base as every command (`serverFetch` in ./http); the session is an
 * HttpOnly cookie the page never sees.
 */
import { serverFetch } from "./http";

/** The server's passphrase must be at least this long (it checks too). */
export const MIN_PASSPHRASE = 12;

export interface AuthState {
  /** A passphrase has been chosen. */
  setUp: boolean;
  /** This page has a live session. */
  signedIn: boolean;
  /** fuse-server's version (PL-06). */
  version: string;
  /** M10 F2: the schema it runs (its count of migrations), and the commit and day it was built. */
  schema?: number;
  builtFrom?: string;
  builtOn?: string;
}

/** A desktop or the runner, paired with a one-time code. Times are seconds since 1970. */
export interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface PairCode {
  /** Like ABCD-EFGH; it works once. */
  code: string;
  /** Seconds since 1970. */
  expiresAt: number;
}

export interface AuthApi {
  state(): Promise<AuthState>;
  /** Chooses the passphrase on the first visit, and signs this page in. */
  setUp(passphrase: string): Promise<void>;
  /** Rejects with what the server said: a wrong passphrase, or a pause after too many. */
  signIn(passphrase: string): Promise<void>;
  signOut(): Promise<void>;
  pairCode(): Promise<PairCode>;
  devices(): Promise<Device[]>;
  /** True if the device was there to remove. */
  revoke(id: string): Promise<boolean>;
}

/** The server said no. `message` is its own words, ready to show. */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const WORDS: Record<string, string> = {
  not_set_up: "FUSE on HULK has no passphrase yet. Reload the page to choose one.",
  signed_out: "You're signed out. Sign in again.",
};

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await serverFetch(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const text = await res.text();
  let data: unknown = null;
  let parsed = !text;
  try {
    data = text ? JSON.parse(text) : null;
    parsed = true;
  } catch {
    // not JSON: a proxy's page, say
  }
  if (!res.ok) {
    const said =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `FUSE on HULK answered ${String(res.status)}.`;
    throw new AuthError(WORDS[said] ?? said, res.status);
  }
  // A page instead of fuse-server's JSON (a proxy, or a dev server's fallback): say so, rather
  // than handing callers something they'd read fields from.
  if (!parsed) throw new AuthError(UNEXPECTED, res.status);
  return data as T;
}

const UNEXPECTED = "FUSE on HULK didn't answer as expected. Check the address and reload.";

/** The sign-in state must be an object: an empty answer would otherwise crash the gate. */
async function readState(): Promise<AuthState> {
  const s = await call<AuthState | null>("/api/auth/state");
  if (!s || typeof s !== "object") throw new AuthError(UNEXPECTED, 200);
  return s;
}

export const httpAuthApi: AuthApi = {
  state: readState,
  setUp: async (passphrase) => {
    await call("/api/auth/set-up", { passphrase });
  },
  signIn: async (passphrase) => {
    await call("/api/auth/sign-in", { passphrase });
  },
  signOut: async () => {
    await call("/api/auth/sign-out", {});
  },
  pairCode: () => call<PairCode>("/api/auth/pair-code", {}),
  devices: () => call<Device[]>("/api/auth/devices"),
  revoke: async (id) => (await call<{ removed: boolean }>("/api/auth/revoke", { id })).removed,
};
