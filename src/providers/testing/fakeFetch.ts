// Test-only FetchLike that replays canned responses and records what the adapter sent.
import type { FetchLike } from "../types";

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body: string;
  /** Split the body into chunks of this many characters (exercises the stream parser). */
  chunkSize?: number;
}

export interface SentRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function fakeFetch(responses: (FakeResponse | Error)[]) {
  const sent: SentRequest[] = [];
  const queue = [...responses];
  const fetch: FetchLike = (url, init) => {
    sent.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    });
    const next = queue.shift();
    if (!next) return Promise.reject(new Error("fakeFetch: no more responses"));
    if (next instanceof Error) return Promise.reject(next);
    const size = next.chunkSize ?? 7;
    const bytes = new TextEncoder().encode(next.body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(stream, { status: next.status ?? 200, headers: next.headers ?? {} }),
    );
  };
  return { fetch, sent };
}

/** Collects a stream's text and final event. */
export async function collect<T extends { type: string; text?: string }>(
  gen: AsyncGenerator<T>,
): Promise<{ text: string; events: T[] }> {
  const events: T[] = [];
  let text = "";
  for await (const ev of gen) {
    events.push(ev);
    if (ev.type === "text" && ev.text) text += ev.text;
  }
  return { text, events };
}

export const noSleep = { sleep: () => Promise.resolve(), random: () => 0 };
