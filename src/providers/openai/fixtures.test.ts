// @vitest-environment node
// Contract tests: the adapter against real OpenAI Responses API output recorded on 2026-10-26.
import { ProviderError, userMessage } from "../errors";
import { collect, fakeFetch, noSleep } from "../testing/fakeFetch";
import { loadFixture } from "../testing/fixtures";
import type { StreamDone, StreamEvent } from "../types";
import { buildRequestBody, createOpenAIAdapter } from "./adapter";
import { READ_FILE, runFakeTool, TOOL_SCENARIOS } from "../testing/tools";

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

// M6 step 2: tool calling, recorded on 2026-10-30. Each scenario is a call, then the follow-up
// request carrying the results; the follow-up the adapter builds must match the one that was sent.
describe("tool calling", () => {
  for (const s of TOOL_SCENARIOS) {
    test(`${s.name}: calls, replay and answer`, async () => {
      const first = loadFixture("openai", s.name);
      const model = first.meta.request_body.model as string;
      const ask = [{ role: "user" as const, content: s.ask }];
      const a = createOpenAIAdapter({ fetch: fakeFetch([first.response]).fetch, retry: noSleep });
      const { events } = await collect(a.streamChat(ask, model, { tools: [READ_FILE] }));
      const calls = events.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
      expect(calls.length).toBe(s.name === "tool-parallel" ? 2 : 1);
      expect(calls.every((c) => c.name === "read_file")).toBe(true);
      const d = done(events);
      expect(d.stopReason).toBe("tool_use");
      expect(d.turn).toMatchObject({ provider: "openai", model });

      // The tool definition is sent exactly as recorded.
      const built = buildRequestBody(ask, model, { tools: [READ_FILE] });
      expect(built.tools).toEqual(first.meta.request_body.tools);

      // The follow-up: the turn replayed unchanged, then the results.
      const second = loadFixture("openai", `${s.name}-result`);
      const history = [
        ...ask,
        { role: "assistant" as const, content: "", native: d.turn },
        { role: "user" as const, content: "", toolResults: calls.map(runFakeTool) },
      ];
      expect(buildRequestBody(history, model, { tools: [READ_FILE] }).input).toEqual(
        second.meta.request_body.input,
      );

      const b = createOpenAIAdapter({ fetch: fakeFetch([second.response]).fetch, retry: noSleep });
      const res = await collect(b.streamChat(history, model, { tools: [READ_FILE] }));
      expect(done(res.events).stopReason).not.toBe("tool_use");
      if (s.answer) expect(res.text.trim()).toBe(s.answer);
      else expect(res.text.length).toBeGreaterThan(0);
    });
  }

  test("a turn can't be replayed on another model", () => {
    const turn = { provider: "openai" as const, model: "one", items: [] };
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

test("reasoning items and phase are kept for replay", async () => {
  const { meta, response } = loadFixture("openai", "tool-error-result");
  const a = createOpenAIAdapter({ fetch: fakeFetch([response]).fetch, retry: noSleep });
  const model = meta.request_body.model as string;
  const { events } = await collect(a.streamChat(HI, model, { tools: [READ_FILE] }));
  const items = done(events).turn?.items as { type: string; encrypted_content?: string }[];
  expect(items.map((i) => i.type)).toEqual(["reasoning", "message"]);
  expect(items[0]?.encrypted_content?.length).toBeGreaterThan(0);
});

test("an error result says so in the text (no error flag on OpenAI)", () => {
  const body = buildRequestBody(
    [
      {
        role: "user",
        content: "",
        toolResults: [{ callId: "c1", content: "nope", isError: true }],
      },
    ],
    "m",
    {},
  );
  expect(body.input).toEqual([
    { type: "function_call_output", call_id: "c1", output: "Error: nope" },
  ]);
});
