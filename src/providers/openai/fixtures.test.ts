// @vitest-environment node
// Contract tests: the adapter against real OpenAI Responses API output recorded on 2026-10-26.
import { ProviderError, userMessage } from "../errors";
import { collect, fakeFetch, noSleep } from "../testing/fakeFetch";
import { loadFixture } from "../testing/fixtures";
import type { StreamDone, StreamEvent } from "../types";
import { createOpenAIAdapter } from "./adapter";

const HI = [{ role: "user" as const, content: "Hi" }];
const done = (events: StreamEvent[]) => events.at(-1) as StreamDone;

function replay(scenario: string) {
  const { meta, response } = loadFixture("openai", scenario);
  const f = fakeFetch([response]);
  return { a: createOpenAIAdapter({ fetch: f.fetch, retry: noSleep }), meta, sent: f.sent };
}

async function failure(scenario: string): Promise<ProviderError> {
  const { a, sent } = replay(scenario);
  const err = await collect(a.streamChat(HI, "m", {})).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(sent).toHaveLength(1); // never retried
  return err as ProviderError;
}

test("text: answer, usage, stop reason and request id", async () => {
  const { a, meta } = replay("text");
  const { text, events } = await collect(a.streamChat(HI, "gpt-6-luna", {}));
  expect(text).toBe("Hello from FUSE.");
  expect(done(events)).toEqual({
    type: "done",
    usage: {
      inputTokens: 15,
      outputTokens: 9,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      webSearchCalls: 0,
    },
    usageReported: true,
    stopReason: "completed",
    providerRequestId: meta.response_headers["x-request-id"],
    attempts: 1,
  });
});

test("multi-turn: answers from the history, reasoning tokens counted", async () => {
  const { a } = replay("multi-turn");
  const { text, events } = await collect(a.streamChat(HI, "gpt-6-luna", {}));
  expect(text).toBe("Isaac");
  expect(done(events).usage).toMatchObject({
    inputTokens: 39,
    outputTokens: 16,
    reasoningTokens: 8,
    webSearchCalls: 0,
  });
});

test("reasoning model: text only, reasoning never shown", async () => {
  const { a } = replay("reasoning");
  const { text, events } = await collect(a.streamChat(HI, "gpt-6.1-sol", {}));
  expect(text).toBe("391");
  expect(done(events).usage).toMatchObject({ outputTokens: 18, reasoningTokens: 11 });
});

test("incomplete: reasoning used the whole budget, so no text but usage still billed", async () => {
  const { a } = replay("incomplete");
  const { text, events } = await collect(a.streamChat(HI, "gpt-6-luna", {}));
  expect(text).toBe("");
  expect(done(events)).toMatchObject({
    stopReason: "max_output_tokens",
    usageReported: true,
    usage: { inputTokens: 16, outputTokens: 40, reasoningTokens: 40 },
  });
});

test("cut-off stream: a stream error, not a silent empty answer", async () => {
  const { a } = replay("aborted");
  const err = await collect(a.streamChat(HI, "gpt-6-luna", {})).catch((e: unknown) => e);
  expect(err).toMatchObject({ kind: "stream" });
});

test("401: auth error with a plain message", async () => {
  const e = await failure("error-401");
  expect(e).toMatchObject({ kind: "auth", status: 401, code: "invalid_api_key" });
  expect(e.providerRequestId).toBeTruthy();
  expect(userMessage(e, "OpenAI")).toBe("OpenAI rejected the API key. Check it in Settings.");
});

test("unknown model: 404 not_found", async () => {
  const e = await failure("error-unknown-model");
  expect(e).toMatchObject({ kind: "not_found", status: 404, code: "model_not_found" });
});
