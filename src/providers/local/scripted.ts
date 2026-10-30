/**
 * Test-only: a local model that answers from a script (LL-02), so tests exercise the local path
 * with no model file. A reply may be text, an error to throw, or a function of the request.
 */
import { ProviderError } from "../errors";
import type { ChatMessage, ChatOptions, ProviderAdapter, StreamEvent } from "../types";

export type LocalReply = string | ProviderError | ((messages: ChatMessage[]) => string);

export interface ScriptedLocal {
  adapter: ProviderAdapter;
  /** Every request, in order: the messages and the system prompt. */
  calls: { messages: ChatMessage[]; system: string | undefined }[];
}

/** Rough token count, as llama.cpp would report for short English text. */
const tokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

export function scriptedLocal(replies: LocalReply[], fallback: LocalReply = "ok"): ScriptedLocal {
  const calls: ScriptedLocal["calls"] = [];
  const adapter: ProviderAdapter = {
    provider: "local",
    listModels: () => Promise.resolve([]),
    async *streamChat(
      messages: ChatMessage[],
      _model: string,
      options: ChatOptions,
    ): AsyncGenerator<StreamEvent> {
      calls.push({ messages, system: options.system });
      const reply = replies.shift() ?? fallback;
      await Promise.resolve();
      if (reply instanceof ProviderError) throw reply;
      const text = typeof reply === "function" ? reply(messages) : reply;
      yield { type: "text", text };
      const input = tokens((options.system ?? "") + messages.map((m) => m.content).join("\n"));
      yield {
        type: "done",
        usage: {
          inputTokens: input,
          outputTokens: tokens(text),
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: true,
        stopReason: "stop",
        providerRequestId: null,
        attempts: 1,
      };
    },
  };
  return { adapter, calls };
}
