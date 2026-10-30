// @vitest-environment node
// Contract tests: the adapter against real Anthropic responses recorded on 2026-10-26.
import { ProviderError, userMessage } from "../errors";
import { collect, fakeFetch, noSleep } from "../testing/fakeFetch";
import { loadFixture } from "../testing/fixtures";
import type { StreamDone, StreamEvent } from "../types";
import { buildRequestBody, createAnthropicAdapter } from "./adapter";
import { READ_FILE, runFakeTool, TOOL_SCENARIOS } from "../testing/tools";

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

// M6 step 2: tool calling, recorded on 2026-10-30. Each scenario is a call, then the follow-up
// request carrying the results; the follow-up the adapter builds must match the one that was sent.
describe("tool calling", () => {
  for (const s of TOOL_SCENARIOS) {
    test(`${s.name}: calls, replay and answer`, async () => {
      const first = loadFixture("anthropic", s.name);
      const model = first.meta.request_body.model as string;
      const ask = [{ role: "user" as const, content: s.ask }];
      const a = createAnthropicAdapter({
        fetch: fakeFetch([first.response]).fetch,
        retry: noSleep,
      });
      const { events } = await collect(a.streamChat(ask, model, { tools: [READ_FILE] }));
      const calls = events.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
      expect(calls.length).toBe(s.name === "tool-parallel" ? 2 : 1);
      expect(calls.every((c) => c.name === "read_file")).toBe(true);
      const d = done(events);
      expect(d.stopReason).toBe("tool_use");
      expect(d.turn).toMatchObject({ provider: "anthropic", model });

      // The tool definition is sent exactly as recorded.
      const built = buildRequestBody(ask, model, { tools: [READ_FILE] });
      expect(built.tools).toEqual(first.meta.request_body.tools);

      // The follow-up: the turn replayed unchanged, then the results.
      const second = loadFixture("anthropic", `${s.name}-result`);
      const history = [
        ...ask,
        { role: "assistant" as const, content: "", native: d.turn },
        { role: "user" as const, content: "", toolResults: calls.map(runFakeTool) },
      ];
      expect(buildRequestBody(history, model, { tools: [READ_FILE] }).messages).toEqual(
        second.meta.request_body.messages,
      );

      const b = createAnthropicAdapter({
        fetch: fakeFetch([second.response]).fetch,
        retry: noSleep,
      });
      const res = await collect(b.streamChat(history, model, { tools: [READ_FILE] }));
      expect(done(res.events).stopReason).not.toBe("tool_use");
      if (s.answer) expect(res.text.trim()).toBe(s.answer);
      else expect(res.text.length).toBeGreaterThan(0);
    });
  }

  test("a turn can't be replayed on another model", () => {
    const turn = { provider: "anthropic" as const, model: "one", items: [] };
    const history = [
      { role: "user" as const, content: "Hi" },
      { role: "assistant" as const, content: "", native: turn },
      { role: "user" as const, content: "", toolResults: [] },
      { role: "user" as const, content: "Next" },
    ];
    expect(() => buildRequestBody(history, "two", {})).toThrow(/another model/);
  });

  test("no tools: no tools field and no turn on done", async () => {
    const { a } = replay("text");
    const { events } = await collect(a.streamChat(HI, "m", {}));
    expect(done(events).turn).toBeUndefined();
    expect(buildRequestBody(HI, "m", {}).tools).toBeUndefined();
  });
});

test("thinking blocks are kept whole, signature included, for replay", async () => {
  const { meta, response } = loadFixture("anthropic", "tool-error-result");
  const a = createAnthropicAdapter({ fetch: fakeFetch([response]).fetch, retry: noSleep });
  const model = meta.request_body.model as string;
  const { events } = await collect(a.streamChat(HI, model, { tools: [READ_FILE] }));
  const items = done(events).turn?.items as {
    type: string;
    signature?: string;
    thinking?: string;
  }[];
  const thinking = items.find((i) => i.type === "thinking");
  expect(thinking?.signature?.length).toBeGreaterThan(0);
  expect(items.map((i) => i.type)).toEqual(["thinking", "text"]);
});

test("an error result is flagged", () => {
  const body = buildRequestBody(
    [
      {
        role: "user",
        content: "",
        toolResults: [{ callId: "t1", content: "nope", isError: true }],
      },
    ],
    "m",
    {},
  );
  expect(body.messages).toEqual([
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "nope", is_error: true }],
    },
  ]);
});
