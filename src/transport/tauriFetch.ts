import { Channel, invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "@/catalog/catalog";
import type { FetchLike } from "@/providers/types";

/** Mirrors `StreamMsg` in src-tauri/src/transport.rs. */
export type StreamMsg =
  | { kind: "head"; status: number; headers: [string, string][] }
  | { kind: "chunk"; data: string }
  | { kind: "end" }
  | { kind: "error"; message: string };

interface Bridge {
  start(request: unknown, onEvent: (m: StreamMsg) => void): Promise<number>;
  abort(id: number): Promise<void>;
}

const tauriBridge: Bridge = {
  start(request, onEvent) {
    const channel = new Channel<StreamMsg>();
    channel.onmessage = onEvent;
    return invoke<number>("provider_fetch", { request, onEvent: channel });
  },
  abort: (id) => invoke("provider_abort", { id }),
};

/** Header on synthetic responses for errors raised before any request was sent. */
export const FUSE_ERROR_HEADER = "x-fuse-error";

/** Turns a refusal from the Rust side into an HTTP-like response the adapters already handle. */
function setupFailure(raw: string): Response | null {
  const m = /^(no_key|keychain|forbidden): (.*)$/s.exec(raw);
  if (!m) return null;
  const [, code = "", message = ""] = m;
  const status = code === "forbidden" ? 400 : 401;
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json", [FUSE_ERROR_HEADER]: code },
  });
}

/**
 * FetchLike for one provider, backed by the Rust transport (which adds the API key and only
 * talks to that provider's host). Adapters pass a full URL; only its path and query are sent.
 */
export function providerFetch(provider: ProviderId, bridge: Bridge = tauriBridge): FetchLike {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let settled = false;
      let id: number | null = null;
      let finished = false;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel() {
          if (id !== null && !finished) void bridge.abort(id);
        },
      });
      const fail = (message: string) => {
        finished = true;
        if (!settled) {
          settled = true;
          reject(new TypeError(message));
        } else {
          controller?.error(new TypeError(message));
        }
      };
      const onEvent = (m: StreamMsg) => {
        switch (m.kind) {
          case "head":
            settled = true;
            resolve(new Response(body, { status: m.status, headers: m.headers }));
            break;
          case "chunk":
            controller?.enqueue(encoder.encode(m.data));
            break;
          case "end":
            finished = true;
            controller?.close();
            break;
          case "error":
            fail(m.message);
            break;
        }
      };
      init.signal?.addEventListener(
        "abort",
        () => {
          if (id !== null && !finished) void bridge.abort(id);
          fail("Aborted");
        },
        { once: true },
      );
      bridge
        .start(
          {
            provider,
            method: init.method,
            path: `${u.pathname}${u.search}`,
            headers: Object.entries(init.headers),
            body: init.body ?? null,
          },
          onEvent,
        )
        .then(
          (streamId) => {
            id = streamId;
            if (init.signal?.aborted) void bridge.abort(streamId);
          },
          (e: unknown) => {
            // Tauri rejects with the command's error string; tests may use Error objects.
            const synthetic = setupFailure(e instanceof Error ? e.message : String(e));
            if (synthetic && !settled) {
              settled = true;
              finished = true;
              resolve(synthetic);
            } else {
              fail(String(e));
            }
          },
        );
    });
}
