/** A server-sent event as defined by the WHATWG EventSource spec (fields we use). */
export interface SseEvent {
  event: string; // "message" when no `event:` field was sent
  data: string;
  id?: string;
}

/**
 * Incremental SSE parser: feed it decoded text chunks of any size (split anywhere, even
 * mid-line or mid-CRLF); it yields complete events. Spec: https://html.spec.whatwg.org/multipage/server-sent-events.html
 */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private id: string | undefined;
  private pendingCR = false;

  push(chunk: string): SseEvent[] {
    let text = chunk;
    if (this.pendingCR) {
      // A CR at the end of the previous chunk already ended a line; drop a following LF.
      if (text.startsWith("\n")) text = text.slice(1);
      this.pendingCR = false;
    }
    this.buffer += text;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer);
      if (!m) break;
      if (m[0] === "\r" && m.index === this.buffer.length - 1) {
        // Could be the first half of CRLF split across chunks.
        this.pendingCR = true;
      }
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** Resets state when the stream ends. */
  end(): void {
    this.buffer = "";
    this.event = "";
    this.data = [];
  }

  private line(line: string): SseEvent | null {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "";
        return null;
      }
      const ev: SseEvent = { event: this.event || "message", data: this.data.join("\n") };
      if (this.id !== undefined) ev.id = this.id;
      this.event = "";
      this.data = [];
      return ev;
    }
    if (line.startsWith(":")) return null; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id" && !value.includes("\0")) this.id = value;
    return null;
  }
}

/** Reads a fetch Response body as SSE events. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.push(decoder.decode());
    // Per spec, an event not terminated by a blank line is dropped (a cut-off stream).
  } finally {
    parser.end();
    reader.releaseLock();
  }
}
