/**
 * The local model (LL-02): a model file on this computer, run by FUSE's own worker
 * (src-tauri/src/local.rs). Never a network request, never a key. Text only: attachments, web
 * search and tools are for cloud models. Until a model is installed and the worker is running,
 * every request fails with a clear reason, and callers fall back to the cloud.
 */
import { ProviderError } from "../errors";
import type { ChatMessage, ChatOptions, ProviderAdapter, StreamEvent } from "../types";

export const NO_LOCAL_MODEL = "No local model is installed. Install one in Settings → Local model.";

/** The adapter while no local model can run. */
export function unavailableLocalAdapter(reason = NO_LOCAL_MODEL): ProviderAdapter {
  return {
    provider: "local",
    listModels: () => Promise.resolve([]),
    // eslint-disable-next-line require-yield -- fails before the first event, by design
    async *streamChat() {
      await Promise.resolve();
      throw new ProviderError("unavailable", reason);
    },
  };
}

/** What the worker streams back (src-tauri/src/local.rs LocalMsg). */
export type LocalMsg =
  | { kind: "text"; text: string }
  | { kind: "done"; input_tokens: number; output_tokens: number; stop: string };

export interface LocalBackend {
  /** Streams one answer on `onMsg`; rejects with the worker's reason. */
  generate(
    req: {
      file: string;
      system: string;
      messages: { role: "user" | "assistant"; content: string }[];
      maxTokens: number;
      timeoutSecs: number;
    },
    onMsg: (m: LocalMsg) => void,
  ): Promise<void>;
  cancel(): Promise<void>;
}

/** Housekeeping replies are short; this bounds a runaway answer. */
export const LOCAL_MAX_OUTPUT = 1024;
export const LOCAL_TIMEOUT_SECS = 120;

/** Removes a thinking block if the model writes one anyway (it's asked not to). */
export const stripThinking = (text: string) => text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, "");

/**
 * The local adapter over the worker. `fileFor` maps a catalog id (e.g. "qwen3-4b") to its
 * installed file, or null when that model isn't installed.
 */
export function createLocalAdapter(opts: {
  backend: LocalBackend;
  fileFor: (modelId: string) => string | null;
}): ProviderAdapter {
  return {
    provider: "local",
    listModels: () => Promise.resolve([]),
    async *streamChat(
      messages: ChatMessage[],
      model: string,
      options: ChatOptions,
      signal?: AbortSignal,
    ): AsyncGenerator<StreamEvent> {
      const file = opts.fileFor(model);
      if (!file) throw new ProviderError("unavailable", NO_LOCAL_MODEL);
      if (signal?.aborted) throw new ProviderError("aborted", "Stopped.");
      // A queue between the worker's channel and this generator.
      const queue: LocalMsg[] = [];
      let wake: (() => void) | null = null;
      // Set from callbacks, so kept on an object the type checker doesn't narrow.
      const state: { finished: boolean; failure: unknown; aborted: boolean } = {
        finished: false,
        failure: null,
        aborted: false,
      };
      const notify = () => {
        wake?.();
        wake = null;
      };
      const onAbort = () => {
        state.aborted = true;
        void opts.backend.cancel();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const running = opts.backend
        .generate(
          {
            file,
            system: options.system ?? "",
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            maxTokens: Math.min(options.maxOutputTokens ?? LOCAL_MAX_OUTPUT, LOCAL_MAX_OUTPUT),
            timeoutSecs: LOCAL_TIMEOUT_SECS,
          },
          (m) => {
            queue.push(m);
            notify();
          },
        )
        .then(
          () => {
            state.finished = true;
            notify();
          },
          (e: unknown) => {
            state.failure = e;
            state.finished = true;
            notify();
          },
        );
      let text = "";
      let done: Extract<LocalMsg, { kind: "done" }> | null = null;
      try {
        for (;;) {
          const m = queue.shift();
          if (m) {
            if (m.kind === "text") {
              text += m.text;
              // Held back until the end, so a stray thinking block never reaches the caller.
            } else {
              done = m;
            }
            continue;
          }
          if (state.finished) break;
          await new Promise<void>((r) => (wake = r));
        }
        await running;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      if (state.aborted) throw new ProviderError("aborted", "Stopped.");
      const failure = state.failure;
      if (failure !== null) {
        // Tauri commands reject with the Rust error text.
        const message =
          failure instanceof Error
            ? failure.message
            : typeof failure === "string"
              ? failure
              : "The local model failed.";
        throw new ProviderError("unavailable", message);
      }
      const answer = stripThinking(text).trim();
      if (!done || !answer) {
        throw new ProviderError("stream", "The local model gave an empty answer.");
      }
      yield { type: "text", text: answer };
      yield {
        type: "done",
        usage: {
          inputTokens: done.input_tokens,
          outputTokens: done.output_tokens,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: true,
        stopReason: done.stop === "length" ? "max_tokens" : done.stop,
        providerRequestId: null,
        attempts: 1,
      };
    },
  };
}
