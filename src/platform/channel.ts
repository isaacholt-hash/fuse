let nextId = 1;

/** Messages a command streams back while it works, like Tauri's Channel. */
export class Channel<T> {
  /** Unique within this page or process; the server routes this channel's messages by it. */
  readonly id = `${String(Date.now())}-${String(nextId++)}`;
  #handler: (message: T) => void = () => {};

  set onmessage(handler: (message: T) => void) {
    this.#handler = handler;
  }
  get onmessage(): (message: T) => void {
    return this.#handler;
  }

  /** Called by the platform when a message arrives. */
  deliver(message: T): void {
    this.#handler(message);
  }
}

export type Args = Record<string, unknown>;

/** A raw byte payload (sent as the body, not JSON) and its headers, as Tauri allows. */
export interface InvokeOptions {
  headers: Record<string, string>;
}
