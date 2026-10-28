// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderError, userMessage } from "../errors";
import { collect, fakeFetch, noSleep } from "../testing/fakeFetch";
import type { StreamDone, StreamEvent } from "../types";
import { ANTHROPIC_VERSION, createAnthropicAdapter, mergeUsage } from "./adapter";

const DOCS_STREAM = readFileSync(join(import.meta.dirname, "testdata/docs-basic.sse"), "utf8");
const HI = [{ role: "user" as const, content: "Hi" }];
const done = (events: StreamEvent[]) => events.at(-1) as StreamDone;

const adapter = (responses: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(responses);
  return { a: createAnthropicAdapter({ fetch: f.fetch, retry: noSleep }), sent: f.sent };
};
const sse = (body: string, headers: Record<string, string> = {}) => ({
  body,
  headers: { "content-type": "text/event-stream", "request-id": "req_test", ...headers },
});

describe("docs example stream", () => {
  test("yields the text, then usage, stop reason and request id", async () => {
    const { a } = adapter([sse(DOCS_STREAM)]);
    const { text, events } = await collect(a.streamChat(HI, "claude-opus-5-5", {}));
    expect(text).toBe("Hello!");
    expect(done(events)).toEqual({
      type: "done",
      usage: {
        inputTokens: 25,
        outputTokens: 15,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        webSearchCalls: 0,
      },
      usageReported: true,
      stopReason: "end_turn",
      providerRequestId: "req_test",
      attempts: 1,
    });
  });

  test("works whatever the network chunk size", async () => {
    for (const chunkSize of [1, 3, 64, 100_000]) {
      const { a } = adapter([{ ...sse(DOCS_STREAM), chunkSize }]);
      expect((await collect(a.streamChat(HI, "m", {}))).text).toBe("Hello!");
    }
  });
});

test("request: right endpoint and headers, no key, no temperature", async () => {
  const { a, sent } = adapter([sse(DOCS_STREAM)]);
  await collect(
    a.streamChat(
      [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      "claude-sonnet-5-5",
      { system: "Be brief.", maxOutputTokens: 500 },
    ),
  );
  const req = sent[0];
  expect(req?.url).toBe("https://api.anthropic.com/v1/messages");
  expect(req?.headers).toEqual({
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  });
  expect(req?.body).toEqual({
    model: "claude-sonnet-5-5",
    max_tokens: 500,
    stream: true,
    cache_control: { type: "ephemeral" },
    system: "Be brief.",
    messages: [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ],
  });
});

test("effort goes in output_config.effort, never as thinking", async () => {
  const { a, sent } = adapter([sse(DOCS_STREAM)]);
  await collect(
    a.streamChat([{ role: "user", content: "a" }], "claude-opus-5-5", { effort: "high" }),
  );
  expect(sent[0]?.body).toMatchObject({ output_config: { effort: "high" } });
  expect(sent[0]?.body).not.toHaveProperty("thinking");
});

test("images go first as base64 blocks, then the text", async () => {
  const { a, sent } = adapter([sse(DOCS_STREAM)]);
  const img = { kind: "image" as const, mediaType: "image/png", data: "iVBORw0KGgo=" };
  await collect(
    a.streamChat([{ role: "user", content: "What is this?", attachments: [img] }], "m", {}),
  );
  expect((sent[0]?.body as { messages: unknown[] }).messages).toEqual([
    {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        },
        { type: "text", text: "What is this?" },
      ],
    },
  ]);
  // An image on its own sends no empty text block.
  const only = adapter([sse(DOCS_STREAM)]);
  await collect(only.a.streamChat([{ role: "user", content: "", attachments: [img] }], "m", {}));
  expect(
    (only.sent[0]?.body as { messages: { content: unknown[] }[] }).messages[0]?.content,
  ).toHaveLength(1);
});

test("refuses a conversation that ends with the assistant (no prefill on 4.6+)", async () => {
  const { a, sent } = adapter([]);
  await expect(
    collect(a.streamChat([...HI, { role: "assistant", content: "x" }], "m", {})),
  ).rejects.toMatchObject({ kind: "invalid_request" });
  expect(sent).toHaveLength(0);
});

test("usage: message_delta is cumulative, last value per field wins", () => {
  const merged = mergeUsage(
    mergeUsage({}, { input_tokens: 2679, output_tokens: 1, cache_read_input_tokens: 0 }),
    { input_tokens: 10682, output_tokens: 510, cache_read_input_tokens: null },
  );
  expect(merged).toEqual({ input_tokens: 10682, output_tokens: 510, cache_read_input_tokens: 0 });
});

test("thinking tokens are reported, cache reads and writes mapped", async () => {
  const stream = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":500,"cache_creation_input_tokens":40,"output_tokens":1}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"391"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":220,"output_tokens_details":{"thinking_tokens":200}}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
  const { a } = adapter([sse(stream)]);
  const { text, events } = await collect(a.streamChat(HI, "m", {}));
  expect(text).toBe("391"); // thinking is not shown
  expect(done(events).usage).toEqual({
    inputTokens: 10,
    cachedInputTokens: 500,
    cacheWriteTokens: 40,
    outputTokens: 220,
    reasoningTokens: 200,
    webSearchCalls: 0,
  });
});

test("a stream with no usage says so instead of inventing zeros", async () => {
  const stream =
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const { a } = adapter([sse(stream)]);
  expect(done((await collect(a.streamChat(HI, "m", {}))).events).usageReported).toBe(false);
});

test("an error event mid-stream keeps the text already shown and fails as 'stream'", async () => {
  const stream =
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Part"}}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
  const { a } = adapter([sse(stream)]);
  const texts: string[] = [];
  await expect(
    (async () => {
      for await (const ev of a.streamChat(HI, "m", {})) if (ev.type === "text") texts.push(ev.text);
    })(),
  ).rejects.toMatchObject({ kind: "stream", code: "overloaded_error", retryable: false });
  expect(texts).toEqual(["Part"]);
});

test("a connection that closes before message_stop is an error, not a finished answer", async () => {
  const cut = DOCS_STREAM.slice(0, DOCS_STREAM.indexOf("event: message_delta"));
  const { a } = adapter([sse(cut)]);
  await expect(collect(a.streamChat(HI, "m", {}))).rejects.toMatchObject({ kind: "stream" });
});

describe("HTTP errors", () => {
  const err = (
    status: number,
    type: string,
    extra: Record<string, unknown> = {},
    headers = {},
  ) => ({
    status,
    headers: { "content-type": "application/json", "request-id": "req_err", ...headers },
    body: JSON.stringify({ type: "error", error: { type, message: `msg ${type}`, ...extra } }),
  });

  test("529 overloaded is retried, then succeeds", async () => {
    const { a, sent } = adapter([err(529, "overloaded_error"), sse(DOCS_STREAM)]);
    const { events } = await collect(a.streamChat(HI, "m", {}));
    expect(sent).toHaveLength(2);
    expect(done(events).attempts).toBe(2);
  });

  test.each([
    [401, "authentication_error", {}, "auth"],
    [402, "billing_error", {}, "billing"],
    [404, "not_found_error", {}, "not_found"],
    [400, "invalid_request_error", {}, "invalid_request"],
    [
      429,
      "rate_limit_error",
      { details: { error_code: "enforced_spend_limit_reached" } },
      "billing",
    ],
  ])("HTTP %i %s is not retried", async (status, type, extra, kind) => {
    const { a, sent } = adapter([err(status, type, extra), sse(DOCS_STREAM)]);
    const e = await collect(a.streamChat(HI, "m", {})).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ kind, status, providerRequestId: "req_err" });
    expect(sent).toHaveLength(1);
  });

  test("429 rate limit is retried and honours retry-after", async () => {
    const sleep = vi.fn((_ms: number, _signal?: AbortSignal) => Promise.resolve());
    const f = fakeFetch([
      err(429, "rate_limit_error", {}, { "retry-after": "3" }),
      sse(DOCS_STREAM),
    ]);
    const a = createAnthropicAdapter({ fetch: f.fetch, retry: { sleep, random: () => 0 } });
    await collect(a.streamChat(HI, "m", {}));
    expect(sleep).toHaveBeenCalledWith(3000, undefined);
  });

  test("network failure is retried, and reported if it persists", async () => {
    const boom = new TypeError("connection reset");
    const { a, sent } = adapter([boom, boom, boom, boom]);
    await expect(collect(a.streamChat(HI, "m", {}))).rejects.toMatchObject({ kind: "network" });
    expect(sent).toHaveLength(4);
  });
});

test("abort stops the stream", async () => {
  const controller = new AbortController();
  const { a } = adapter([sse(DOCS_STREAM)]);
  const gen = a.streamChat(HI, "m", {}, controller.signal);
  const first = await gen.next();
  expect(first.value).toMatchObject({ type: "text", text: "Hello" });
  controller.abort();
  await expect(gen.next()).rejects.toMatchObject({ kind: "aborted" });
});

test("listModels maps ids and display names", async () => {
  const { a, sent } = adapter([
    {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] }),
    },
  ]);
  expect(await a.listModels()).toEqual([{ id: "claude-opus-5-5", displayName: "Claude Opus 5.5" }]);
  expect(sent[0]?.method).toBe("GET");
});

test("FUSE transport refusals are classified, not retried", async () => {
  const { a, sent } = adapter([
    { status: 401, headers: { "x-fuse-error": "no_key" }, body: '{"error":{"message":"x"}}' },
  ]);
  const e = await collect(a.streamChat(HI, "m", {})).catch((x: unknown) => x);
  expect(e).toMatchObject({ kind: "auth", code: "no_key" });
  expect(userMessage(e as ProviderError, "Anthropic")).toBe(
    "No Anthropic key yet. Add one in Settings.",
  );
  expect(sent).toHaveLength(1);
});

test("PDFs and text files go as titled document blocks", async () => {
  const { a, sent } = adapter([sse(DOCS_STREAM)]);
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
      "m",
      {},
    ),
  );
  expect((sent[0]?.body as { messages: { content: unknown }[] }).messages[0]?.content).toEqual([
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
      title: "a.pdf",
    },
    {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "# B" },
      title: "b.md",
    },
    { type: "text", text: "Compare" },
  ]);
});

describe("web search", () => {
  // Shaped like the docs' streaming example (web-search-tool, 2026-10-27).
  const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const SEARCH_STREAM = [
    ev("message_start", {
      type: "message_start",
      message: { usage: { input_tokens: 50, output_tokens: 1 } },
    }),
    ev("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    ev("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "I'll look that up." },
    }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search" },
    }),
    ev("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"query":"claude shannon born"}' },
    }),
    ev("content_block_stop", { type: "content_block_stop", index: 1 }),
    ev("content_block_start", {
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [
          {
            type: "web_search_result",
            title: "Claude Shannon",
            url: "https://en.wikipedia.org/wiki/Claude_Shannon",
          },
        ],
      },
    }),
    ev("content_block_stop", { type: "content_block_stop", index: 2 }),
    ev("content_block_start", {
      type: "content_block_start",
      index: 3,
      content_block: { type: "text", text: "" },
    }),
    ev("content_block_delta", {
      type: "content_block_delta",
      index: 3,
      delta: { type: "text_delta", text: "He was born in 1916." },
    }),
    ev("content_block_delta", {
      type: "content_block_delta",
      index: 3,
      delta: {
        type: "citations_delta",
        citation: {
          type: "web_search_result_location",
          url: "https://en.wikipedia.org/wiki/Claude_Shannon",
          title: "Claude Shannon - Wikipedia",
          cited_text: "Claude Elwood Shannon (April 30, 1916",
          encrypted_index: "Eo8B",
        },
      },
    }),
    ev("content_block_stop", { type: "content_block_stop", index: 3 }),
    ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 6039,
        output_tokens: 931,
        server_tool_use: { web_search_requests: 1 },
      },
    }),
    ev("message_stop", { type: "message_stop" }),
  ].join("");

  test("request carries the basic search tool only when asked", async () => {
    const { a, sent } = adapter([sse(SEARCH_STREAM), sse(DOCS_STREAM)]);
    await collect(a.streamChat(HI, "m", { webSearch: true }));
    expect((sent[0]?.body as { tools: unknown }).tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
    ]);
    await collect(a.streamChat(HI, "m", {}));
    expect(sent[1]?.body).not.toHaveProperty("tools");
  });

  test("status while searching, a paragraph break after it, citations, and the search count", async () => {
    const { a } = adapter([sse(SEARCH_STREAM)]);
    const { text, events } = await collect(a.streamChat(HI, "m", { webSearch: true }));
    expect(text).toBe("I'll look that up.\n\nHe was born in 1916.");
    expect(events.filter((e) => e.type === "status")).toEqual([
      { type: "status", status: "searching" },
      { type: "status", status: null },
    ]);
    expect(events.filter((e) => e.type === "citation")).toEqual([
      {
        type: "citation",
        url: "https://en.wikipedia.org/wiki/Claude_Shannon",
        title: "Claude Shannon - Wikipedia",
      },
    ]);
    expect(done(events).usage).toMatchObject({
      inputTokens: 6039,
      outputTokens: 931,
      webSearchCalls: 1,
    });
  });
});
