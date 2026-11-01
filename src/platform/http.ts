/**
 * The platform over HTTP (M10): fuse-server on HULK, from the web app or the runner.
 *
 * - A command is `POST /api/invoke/<command>` with its arguments as JSON. The reply is its result,
 *   or `{ "error": … }` with a failing status, which rejects with that value as Tauri does.
 *   Raw bytes go as an octet-stream body with their headers, and a command that returns bytes
 *   answers with an octet-stream, given back as an ArrayBuffer, as on the desktop.
 * - A `Channel` argument is sent as `{ "__fuse_channel": id }`. Its messages come over one
 *   WebSocket per page or process (`/api/events`) as `{ channel, message }`, in order, and
 *   `{ channel, close: true }` once the command drops it.
 * - The browser signs in with its session cookie. The runner sends its device token as a bearer
 *   header, and as the WebSocket's first message, since a WebSocket can't carry headers.
 */
import { Channel, type Args, type InvokeOptions } from "./channel";

export interface HttpConfig {
  /** Where fuse-server is; "" means this page's own origin. */
  base: string;
  /** A device token (the runner); the browser leaves it out and uses its cookie. */
  token?: string;
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
}

let config: HttpConfig = {
  base: "",
  fetch: (...a) => globalThis.fetch(...a),
  get WebSocket() {
    return globalThis.WebSocket;
  },
};

/** This page's or process's id, so the server knows which socket a channel's messages go to. */
let client = newClient();
const channels = new Map<string, Channel<unknown>>();
let socket: Promise<WebSocket> | null = null;

function newClient(): string {
  return globalThis.crypto.randomUUID();
}

/** Points the HTTP platform somewhere else (the runner, tests); resets any open socket. */
export function configureHttp(next: Partial<HttpConfig>): void {
  config = { ...config, ...next };
  void socket?.then((ws) => {
    ws.close();
  });
  socket = null;
  channels.clear();
  client = newClient();
}

function url(path: string): string {
  return `${config.base}${path}`;
}

function wsUrl(path: string): string {
  const base = config.base || globalThis.location.origin;
  const u = new URL(path, base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

/** A request to fuse-server itself (sign-in, devices: src/platform/auth.ts), at the same base. */
export function serverFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return config.fetch(url(path), { credentials: "same-origin", ...init });
}

const signedOutListeners = new Set<() => void>();

/**
 * Calls `listener` whenever the server says this page is signed out (its session expired or was
 * signed out elsewhere), so the web app can show the sign-in screen again. Returns a function
 * that stops listening.
 */
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => {
    signedOutListeners.delete(listener);
  };
}

function openSocket(): Promise<WebSocket> {
  if (socket) return socket;
  const opening = new Promise<WebSocket>((resolve, reject) => {
    const ws = new config.WebSocket(wsUrl(`/api/events?client=${client}`));
    ws.onopen = () => {
      if (config.token) ws.send(JSON.stringify({ auth: config.token }));
      resolve(ws);
    };
    ws.onmessage = (e: MessageEvent) => {
      const m = JSON.parse(String(e.data)) as {
        channel: string;
        message?: unknown;
        close?: boolean;
      };
      const ch = channels.get(m.channel);
      if (!ch) return;
      if (m.close) channels.delete(m.channel);
      else ch.deliver(m.message);
    };
    ws.onerror = () => {
      reject(new Error("Couldn't reach FUSE on the server."));
    };
    ws.onclose = () => {
      // Streams in flight can't resume on a new socket; the next channel opens one.
      if (socket === opening) socket = null;
      channels.clear();
    };
  });
  socket = opening;
  return opening;
}

export async function httpInvoke<T>(
  cmd: string,
  args?: Args | Uint8Array,
  options?: InvokeOptions,
): Promise<T> {
  const raw = args instanceof Uint8Array ? args : null;
  const body: Args = {};
  const opened: string[] = [];
  for (const [k, v] of Object.entries(raw ? {} : (args ?? {}))) {
    if (v instanceof Channel) {
      channels.set(v.id, v as Channel<unknown>);
      opened.push(v.id);
      body[k] = { __fuse_channel: v.id };
    } else body[k] = v;
  }
  if (opened.length) await openSocket();
  const headers: Record<string, string> = {
    ...options?.headers,
    "content-type": raw ? "application/octet-stream" : "application/json",
    "x-fuse-client": client,
  };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  const res = await config.fetch(url(`/api/invoke/${encodeURIComponent(cmd)}`), {
    method: "POST",
    headers,
    // A copy, so the body is a plain ArrayBuffer-backed view fetch accepts.
    body: raw ? new Uint8Array(raw) : JSON.stringify(body),
    credentials: "same-origin",
  });
  if (res.ok && res.headers.get("content-type") === "application/octet-stream") {
    return (await res.arrayBuffer()) as T;
  }
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    for (const id of opened) channels.delete(id);
    const error =
      data && typeof data === "object" && "error" in data
        ? data.error
        : `FUSE on the server answered ${String(res.status)}.`;
    if (res.status === 401 && error === "signed_out") {
      for (const listener of signedOutListeners) listener();
    }
    // Rejects with the command's own error value, as Tauri's invoke does.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return Promise.reject(error);
  }
  return data as T;
}

/** A URL for a file the server serves under `protocol` (previews). */
export function httpConvertFileSrc(path: string, protocol: string): string {
  return url(`/api/asset/${encodeURIComponent(protocol)}/${encodeURIComponent(path)}`);
}
