// @vitest-environment node
// Contract tests: the adapter against real Anthropic responses recorded on 2026-10-26.
import { ProviderError, userMessage } from "../errors";
import { collect, fakeFetch, noSleep } from "../testing/fakeFetch";
import { loadFixture } from "../testing/fixtures";
import type { StreamDone, StreamEvent } from "../types";
import { createAnthropicAdapter } from "./adapter";

const HI = [{ role: "user" as const, content: "Hi" }];
const done = (events: StreamEvent[]) => events.at(-1) as StreamDone;

function replay(scenario: string) {
  const { meta, response } = loadFixture("anthropic", scenario);
  const f = fakeFetch([response]);
  return { a: createAnthropicAdapter({ fetch: f.fetch, retry: noSleep }), meta, sent: f.sent };
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
  const { text, events } = await collect(a.streamChat(HI, "claude-haiku-5-5", {}));
  expect(text).toBe("Hello from FUSE.");
  expect(done(events)).toEqual({
    type: "done",
    usage: {
      inputTokens: 25,
      outputTokens: 11,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      webSearchCalls: 0,
    },
    usageReported: true,
    stopReason: "end_turn",
    providerRequestId: meta.response_headers["request-id"],
    attempts: 1,
  });
});

test("multi-turn: answers from the history", async () => {
  const { a } = replay("multi-turn");
  expect((await collect(a.streamChat(HI, "claude-haiku-5-5", {}))).text).toBe("Isaac");
});

test("reasoning model: text only, thinking never shown", async () => {
  const { a } = replay("reasoning");
  const { text, events } = await collect(a.streamChat(HI, "claude-sonnet-5-5", {}));
  expect(text).toBe("391");
  expect(done(events).usage.outputTokens).toBe(3);
});

test("cut-off stream: partial text is yielded, then a stream error", async () => {
  const { a } = replay("aborted");
  const seen: string[] = [];
  const err = await (async () => {
    for await (const ev of a.streamChat(HI, "claude-haiku-5-5", {}))
      if (ev.type === "text") seen.push(ev.text);
  })().catch((e: unknown) => e);
  expect(seen.join("")).toBe("1\n2\n3"); // the thinking block before it is skipped
  expect(err).toMatchObject({ kind: "stream" });
});

test("401: auth error with a plain message", async () => {
  const e = await failure("error-401");
  expect(e).toMatchObject({ kind: "auth", status: 401, code: "authentication_error" });
  expect(e.providerRequestId).toMatch(/^req_/);
  expect(userMessage(e, "Anthropic")).toBe("Anthropic rejected the API key. Check it in Settings.");
});

test("temperature: 400 invalid request, shown with the provider's reason", async () => {
  const e = await failure("error-temperature");
  expect(e).toMatchObject({ kind: "invalid_request", status: 400 });
  expect(userMessage(e, "Anthropic")).toContain("temperature");
});

test("unknown model: 404 not_found", async () => {
  const e = await failure("error-unknown-model");
  expect(e).toMatchObject({ kind: "not_found", status: 404, code: "not_found_error" });
});
