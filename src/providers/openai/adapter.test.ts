// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderError } from "../errors";
import { collect, fakeFetch, noSleep } from "../testing/fakeFetch";
import type { StreamDone, StreamEvent } from "../types";
import { createOpenAIAdapter, normaliseUsage } from "./adapter";

const STREAM = readFileSync(join(import.meta.dirname, "testdata/docs-constructed.sse"), "utf8");
const HI = [{ role: "user" as const, content: "Hi" }];
const done = (events: StreamEvent[]) => events.at(-1) as StreamDone;

const adapter = (responses: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(responses);
  return { a: createOpenAIAdapter({ fetch: f.fetch, retry: noSleep }), sent: f.sent };
};
const sse = (body: string) => ({
  body,
  headers: { "content-type": "text/event-stream", "x-request-id": "req_oa" },
});
const event = (o: Record<string, unknown>) =>
  `event: ${String(o.type)}\ndata: ${JSON.stringify(o)}\n\n`;

test("streams text deltas, then usage from response.completed", async () => {
  const { a } = adapter([sse(STREAM)]);
  const { text, events } = await collect(a.streamChat(HI, "gpt-6-luna", {}));
  expect(text).toBe("Hello from FUSE.");
  expect(done(events)).toEqual({
    type: "done",
    usage: {
      inputTokens: 36,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 12,
      reasoningTokens: 4,
      webSearchCalls: 0,
    },
    usageReported: true,
    stopReason: "completed",
    providerRequestId: "req_oa",
    attempts: 1,
  });
});

test("request: Responses API, store false, Standard tier, no temperature, no key", async () => {
  const { a, sent } = adapter([sse(STREAM)]);
  await collect(
    a.streamChat(
      [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      "gpt-6.1-sol",
      { system: "Be brief.", maxOutputTokens: 500 },
    ),
  );
  expect(sent[0]?.url).toBe("https://api.openai.com/v1/responses");
  expect(sent[0]?.headers).toEqual({ "content-type": "application/json" });
  expect(sent[0]?.body).toEqual({
    model: "gpt-6.1-sol",
    input: [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ],
    stream: true,
    store: false,
    service_tier: "default",
    max_output_tokens: 500,
    instructions: "Be brief.",
  });
});

test("usage: cache reads and writes are taken out of input_tokens", () => {
  expect(
    normaliseUsage({
      input_tokens: 10_000,
      output_tokens: 1186,
      input_tokens_details: { cached_tokens: 6000, cache_write_tokens: 3000 },
      output_tokens_details: { reasoning_tokens: 1024 },
    }),
  ).toEqual({
    inputTokens: 1000,
    cachedInputTokens: 6000,
    cacheWriteTokens: 3000,
    outputTokens: 1186,
    reasoningTokens: 1024,
    webSearchCalls: 0,
  });
});

test("response.incomplete finishes with its reason and usage", async () => {
  const stream =
    event({ type: "response.output_text.delta", delta: "Once upon" }) +
    event({
      type: "response.incomplete",
      response: {
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 20, output_tokens: 40 },
      },
    });
  const { a } = adapter([sse(stream)]);
  const { text, events } = await collect(a.streamChat(HI, "m", {}));
  expect(text).toBe("Once upon");
  expect(done(events)).toMatchObject({
    stopReason: "max_output_tokens",
    usage: { outputTokens: 40 },
  });
});

test.each([
  [
    "response.failed",
    { type: "response.failed", response: { error: { code: "server_error", message: "failed" } } },
    "server_error",
  ],
  [
    "error event",
    { type: "error", code: "ERR_X", message: "Something went wrong", param: null },
    "ERR_X",
  ],
])("%s mid-stream fails as 'stream' after the text already shown", async (_n, ev, code) => {
  const { a } = adapter([
    sse(event({ type: "response.output_text.delta", delta: "Part" }) + event(ev)),
  ]);
  const texts: string[] = [];
  await expect(
    (async () => {
      for await (const e of a.streamChat(HI, "m", {})) if (e.type === "text") texts.push(e.text);
    })(),
  ).rejects.toMatchObject({ kind: "stream", code });
  expect(texts).toEqual(["Part"]);
});

test("a stream without a terminal event is an error; a [DONE] sentinel is ignored", async () => {
  const cut = STREAM.slice(0, STREAM.indexOf("event: response.completed"));
  const { a } = adapter([sse(cut)]);
  await expect(collect(a.streamChat(HI, "m", {}))).rejects.toMatchObject({ kind: "stream" });

  const { a: b } = adapter([sse(`${STREAM}data: [DONE]\n\n`)]);
  expect((await collect(b.streamChat(HI, "m", {}))).text).toBe("Hello from FUSE.");
});

describe("HTTP errors", () => {
  const err = (status: number, code: string | null, type = "invalid_request_error") => ({
    status,
    headers: { "content-type": "application/json", "x-request-id": "req_err" },
    body: JSON.stringify({ error: { message: `msg ${String(code)}`, type, param: null, code } }),
  });

  test.each([
    [429, "credit_balance_exhausted", "insufficient_quota", "billing"],
    [429, "project_spend_limit_exceeded", "insufficient_quota", "billing"],
    [429, null, "insufficient_quota", "billing"],
    [401, "invalid_api_key", "invalid_request_error", "auth"],
    [404, "model_not_found", "invalid_request_error", "not_found"],
    [400, null, "invalid_request_error", "invalid_request"],
  ])("HTTP %i %s is not retried", async (status, code, type, kind) => {
    const { a, sent } = adapter([err(status, code, type), sse(STREAM)]);
    const e = await collect(a.streamChat(HI, "m", {})).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ kind, status, providerRequestId: "req_err" });
    expect(sent).toHaveLength(1);
  });

  test.each([
    [429, "slow_down", "rate_limit_error"],
    [429, null, "rate_limit_error"],
    [503, "server_is_overloaded", "service_unavailable_error"],
    [500, null, "server_error"],
  ])("HTTP %i %s is retried", async (status, code, type) => {
    const { a, sent } = adapter([err(status, code, type), sse(STREAM)]);
    const { events } = await collect(a.streamChat(HI, "m", {}));
    expect(sent).toHaveLength(2);
    expect(done(events).attempts).toBe(2);
  });
});

test("listModels returns ids", async () => {
  const { a } = adapter([
    {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object: "list", data: [{ id: "gpt-6-luna", object: "model" }] }),
    },
  ]);
  expect(await a.listModels()).toEqual([{ id: "gpt-6-luna", displayName: null }]);
});

test("images go first as data URLs with detail high, then the text", async () => {
  const { a, sent } = adapter([sse(STREAM)]);
  const img = { kind: "image" as const, mediaType: "image/jpeg", data: "/9j/4AAQ" };
  await collect(
    a.streamChat(
      [{ role: "user", content: "What is this?", attachments: [img] }],
      "gpt-6-luna",
      {},
    ),
  );
  expect((sent[0]?.body as { input: unknown[] }).input).toEqual([
    {
      role: "user",
      content: [
        { type: "input_image", image_url: "data:image/jpeg;base64,/9j/4AAQ", detail: "high" },
        { type: "input_text", text: "What is this?" },
      ],
    },
  ]);
});

test("PDFs go as input_file data URLs; text files as named input_text", async () => {
  const { a, sent } = adapter([sse(STREAM)]);
  await collect(
    a.streamChat(
      [
        {
          role: "user",
          content: "Compare",
          attachments: [
            { kind: "pdf", name: "a.pdf", data: "JVBERi0=" },
            { kind: "text", name: "b.md", text: "# B" },
          ],
        },
      ],
      "gpt-6-luna",
      {},
    ),
  );
  expect((sent[0]?.body as { input: { content: unknown }[] }).input[0]?.content).toEqual([
    { type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64,JVBERi0=" },
    { type: "input_text", text: '<file name="b.md">\n# B\n</file>' },
    { type: "input_text", text: "Compare" },
  ]);
});

describe("web search", () => {
  const ev = (data: { type: string } & Record<string, unknown>) =>
    `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
  const SEARCH_STREAM = [
    ev({ type: "response.created", response: {} }),
    ev({ type: "response.web_search_call.in_progress", item_id: "ws_1", output_index: 0 }),
    ev({ type: "response.web_search_call.searching", item_id: "ws_1", output_index: 0 }),
    ev({ type: "response.web_search_call.completed", item_id: "ws_1", output_index: 0 }),
    ev({ type: "response.output_text.delta", delta: "Born in 1916." }),
    ev({
      type: "response.output_text.annotation.added",
      annotation_index: 0,
      annotation: {
        type: "url_citation",
        url: "https://example.com/shannon",
        title: "Shannon",
        start_index: 0,
        end_index: 13,
      },
    }),
    ev({
      type: "response.completed",
      response: {
        output: [
          {
            type: "web_search_call",
            id: "ws_1",
            status: "completed",
            action: { type: "search", query: "shannon" },
          },
          {
            type: "web_search_call",
            id: "ws_2",
            status: "completed",
            action: { type: "open_page", url: "https://example.com/shannon" },
          },
          { type: "message", content: [] },
        ],
        usage: { input_tokens: 900, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } },
      },
    }),
  ].join("");

  test("request carries the search tool with an approximate location only when asked", async () => {
    const { a, sent } = adapter([sse(SEARCH_STREAM)]);
    await collect(a.streamChat(HI, "gpt-6-luna", { webSearch: true }));
    expect((sent[0]?.body as { tools: unknown }).tools).toEqual([
      { type: "web_search", user_location: { type: "approximate" } },
    ]);
  });

  test("status, citations, and only search actions are counted (not page opens)", async () => {
    const { a } = adapter([sse(SEARCH_STREAM)]);
    const { text, events } = await collect(a.streamChat(HI, "gpt-6-luna", { webSearch: true }));
    expect(text).toBe("Born in 1916.");
    expect(events.flatMap((e) => (e.type === "status" ? [e.status] : []))).toEqual([
      "searching",
      "searching",
      null,
    ]);
    expect(events.filter((e) => e.type === "citation")).toEqual([
      { type: "citation", url: "https://example.com/shannon", title: "Shannon" },
    ]);
    expect(done(events).usage.webSearchCalls).toBe(1);
  });
});
