// @vitest-environment node
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import { memoryFilesApi, toBase64 } from "@/files/api";
import { ProviderError } from "@/providers/errors";
import { createOpenAIAdapter } from "@/providers/openai/adapter";
import { fakeFetch, noSleep } from "@/providers/testing/fakeFetch";
import { loadFixture } from "@/providers/testing/fixtures";
import type { ChatMessage, ChatOptions, ProviderAdapter, StreamEvent } from "@/providers/types";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { citationsForMessages } from "@/storage/citations";
import { addFile } from "@/storage/files";
import { listMessages } from "@/storage/messages";
import { listRecentRequests } from "@/storage/requestLog";
import { openTestDb } from "@/storage/testing/nodeDb";
import { setGlobalInstructions } from "@/storage/instructions";
import { createProject, updateProject } from "@/storage/projects";
import {
  createThread,
  getThread,
  setThreadInstructions,
  setThreadProject,
} from "@/storage/threads";
import { historyFor, retryLast, sendMessage, type ChatDeps } from "./sendMessage";

const t = DEFAULT_TENANT;
// Placeholder prices for arithmetic; real ones live in data/models.json.
const catalog = parseCatalog({
  price_version: "2026-10-26",
  models: [
    {
      provider: "anthropic",
      id: "test-claude",
      display_name: "Test Claude",
      context_window: 200000,
      max_output: 1000,
      price: { input: 2, output: 10, cached_input: 0.1, cache_write: 2.5 },
      capabilities: [],
      verified_on: "2026-10-26",
      source_url: "https://example.com",
    },
    {
      provider: "openai",
      id: "test-gpt",
      display_name: "Test GPT",
      context_window: 200000,
      max_output: 1000,
      price: { input: 1, output: 4 },
      capabilities: [],
      verified_on: "2026-10-26",
      source_url: "https://example.com",
    },
  ],
});
const claude = catalog.models[0] as CatalogModel;
const gpt = catalog.models[1] as CatalogModel;

type Script = (history: ChatMessage[], signal?: AbortSignal) => AsyncGenerator<StreamEvent>;

function fakeAdapter(provider: "anthropic" | "openai", script: Script) {
  const calls: ChatMessage[][] = [];
  const options: ChatOptions[] = [];
  const adapter: ProviderAdapter = {
    provider,
    listModels: () => Promise.resolve([]),
    streamChat(history, _model, opts, signal) {
      calls.push(history);
      options.push(opts);
      return script(history, signal);
    },
  };
  return { adapter, calls, options };
}

async function* answer(text: string, input = 100, output = 50): AsyncGenerator<StreamEvent> {
  for (const word of text.split(/(?= )/)) {
    await Promise.resolve();
    yield { type: "text", text: word };
  }
  yield {
    type: "done",
    usage: {
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      webSearchCalls: 0,
    },
    usageReported: true,
    stopReason: "end_turn",
    providerRequestId: "req_x",
    attempts: 1,
  };
}

function setup(scripts: Partial<Record<"anthropic" | "openai", Script>>) {
  const db = openTestDb();
  let clock = 1_800_000_000_000;
  const fakes = {
    anthropic: fakeAdapter("anthropic", scripts.anthropic ?? (() => answer("hi"))),
    openai: fakeAdapter("openai", scripts.openai ?? (() => answer("hi"))),
  };
  const deps: ChatDeps = {
    db,
    tenant: t,
    catalog,
    adapterFor: (p) => fakes[p].adapter,
    now: () => (clock += 100),
    saveEveryMs: 250,
  };
  return { db, deps, fakes };
}

beforeEach(() => {
  let c = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (c += 10));
});
afterEach(() => {
  vi.restoreAllMocks();
});

test("send: saves both turns, prices the answer, logs the request, titles the thread", async () => {
  const { db, deps } = setup({ anthropic: () => answer("Hello there, Isaac.", 1200, 400) });
  const thread = await createThread(db, t);
  const seen: string[] = [];
  const r = await sendMessage(deps, {
    threadId: thread.id,
    model: claude,
    text: "  Say hello  ",
    onText: (s) => seen.push(s),
  });

  // 1,200 × $2/MTok + 400 × $10/MTok = $0.0024 + $0.0040 = $0.0064
  expect(r).toMatchObject({ status: "complete", costMicroUsd: 6_400 });
  expect(seen.at(-1)).toBe("Hello there, Isaac.");

  const [user, assistant] = await listMessages(db, t, thread.id);
  expect(user).toMatchObject({ role: "user", content: "Say hello" });
  expect(assistant).toMatchObject({
    role: "assistant",
    parentId: user?.id,
    content: "Hello there, Isaac.",
    status: "complete",
    provider: "anthropic",
    model: "test-claude",
    usage: {
      inputTokens: 1200,
      outputTokens: 400,
      costMicroUsd: 6_400,
      priceVersion: "2026-10-26",
    },
  });
  expect(assistant?.usage.ttftMs).toBeGreaterThan(0);
  expect(assistant?.usage.latencyMs).toBeGreaterThanOrEqual(assistant?.usage.ttftMs ?? 0);

  const [log] = await listRecentRequests(db, t);
  expect(log).toMatchObject({
    purpose: "chat",
    messageId: assistant?.id,
    httpStatus: 200,
    providerRequestId: "req_x",
  });
  expect(assistant?.requestId).toBe(log?.id);

  expect((await getThread(db, t, thread.id))?.title).toBe("Say hello");
  expect((await getThread(db, t, thread.id))?.costMicroUsd).toBe(6_400);
});

test("switching model mid-thread sends the whole conversation to the new model", async () => {
  const { db, deps, fakes } = setup({});
  const thread = await createThread(db, t);
  await sendMessage(deps, { threadId: thread.id, model: claude, text: "My name is Isaac." });
  await sendMessage(deps, { threadId: thread.id, model: gpt, text: "What is my name?" });
  expect(fakes.openai.calls[0]).toEqual([
    { role: "user", content: "My name is Isaac." },
    { role: "assistant", content: "hi" },
    { role: "user", content: "What is my name?" },
  ]);
  const msgs = await listMessages(db, t, thread.id);
  expect(msgs.map((m) => m.provider)).toEqual([null, "anthropic", null, "openai"]);
});

test("streamed text is saved while it arrives (nothing lost if the app dies)", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const { db, deps } = setup({
    anthropic: async function* () {
      for (const w of ["one ", "two ", "three ", "four "]) {
        await Promise.resolve();
        yield { type: "text", text: w };
      }
      await gate;
      yield* answer("");
    },
  });
  const thread = await createThread(db, t);
  const pending = sendMessage(deps, { threadId: thread.id, model: claude, text: "count" });
  await new Promise((r) => setTimeout(r, 0));
  const mid = (await listMessages(db, t, thread.id))[1];
  expect(mid?.status).toBe("streaming");
  expect(mid?.content.length).toBeGreaterThan(0);
  release();
  await pending;
});

test("stop keeps the partial answer, marked stopped", async () => {
  const controller = new AbortController();
  const { db, deps } = setup({
    anthropic: async function* (_h, signal) {
      await Promise.resolve();
      yield { type: "text", text: "Partial" };
      controller.abort();
      if (signal?.aborted) throw new ProviderError("aborted", "Aborted");
    },
  });
  const thread = await createThread(db, t);
  const r = await sendMessage(deps, {
    threadId: thread.id,
    model: claude,
    text: "go",
    signal: controller.signal,
  });
  expect(r.status).toBe("stopped");
  expect(r.error).toBeUndefined();
  expect((await listMessages(db, t, thread.id))[1]).toMatchObject({
    status: "stopped",
    content: "Partial",
  });
});

test("a provider error is stored with a plain-English message and logged", async () => {
  const { db, deps } = setup({
    anthropic: async function* () {
      await Promise.resolve();
      yield* [];
      throw new ProviderError("auth", "invalid x-api-key", {
        status: 401,
        code: "authentication_error",
      });
    },
  });
  const thread = await createThread(db, t);
  const r = await sendMessage(deps, { threadId: thread.id, model: claude, text: "hi" });
  expect(r).toMatchObject({
    status: "error",
    error: "Anthropic rejected the API key. Check it in Settings.",
  });
  expect((await listMessages(db, t, thread.id))[1]).toMatchObject({
    status: "error",
    errorCode: "auth",
  });
  expect((await listRecentRequests(db, t))[0]).toMatchObject({
    httpStatus: 401,
    errorCode: "authentication_error",
  });
});

test("retry replaces the failed answer, on any model", async () => {
  let fail = true;
  const { db, deps, fakes } = setup({
    anthropic: async function* () {
      await Promise.resolve();
      if (fail) {
        yield { type: "text", text: "Half" };
        throw new ProviderError("stream", "Overloaded", { code: "overloaded_error" });
      }
      yield* answer("Whole answer");
    },
  });
  const thread = await createThread(db, t);
  await sendMessage(deps, { threadId: thread.id, model: claude, text: "question" });
  fail = false;
  const r = await retryLast(deps, { threadId: thread.id, model: gpt });
  expect(r.status).toBe("complete");
  const msgs = await listMessages(db, t, thread.id);
  expect(msgs.map((m) => [m.role, m.content, m.status])).toEqual([
    ["user", "question", "complete"],
    ["assistant", "hi", "complete"],
  ]);
  expect(fakes.openai.calls[0]).toEqual([{ role: "user", content: "question" }]);
});

test("no usage from the provider: cost unknown, not a fake $0", async () => {
  const { db, deps } = setup({
    anthropic: async function* () {
      await Promise.resolve();
      yield { type: "text", text: "x" };
      yield {
        type: "done",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: false,
        stopReason: null,
        providerRequestId: null,
        attempts: 1,
      };
    },
  });
  const thread = await createThread(db, t);
  await sendMessage(deps, { threadId: thread.id, model: claude, text: "hi" });
  expect((await listMessages(db, t, thread.id))[1]?.usage.priceVersion).toBeNull();
});

test("history skips empty failed answers but keeps partial ones", () => {
  const m = (role: "user" | "assistant", content: string) =>
    ({ role, content }) as Parameters<typeof historyFor>[0][number];
  expect(
    historyFor([m("user", "a"), m("assistant", ""), m("user", "b"), m("assistant", "part")]),
  ).toEqual([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "assistant", content: "part" },
  ]);
});

test("reasoning used the whole output limit (real OpenAI recording): billed, flagged, not an error", async () => {
  const recorded = fakeFetch([loadFixture("openai", "incomplete").response]);
  const real = createOpenAIAdapter({ fetch: recorded.fetch, retry: noSleep });
  const { db, deps } = setup({
    openai: (history, signal) => real.streamChat(history, "gpt-6-luna", {}, signal),
  });
  const thread = await createThread(db, t);
  const result = await sendMessage(deps, { threadId: thread.id, model: gpt, text: "story" });
  expect(result).toMatchObject({
    status: "complete",
    costMicroUsd: 176, // 16 in × $1 + 40 out × $4 per MTok
    notice: "The model used its whole output limit thinking and gave no answer. Try again.",
  });
  expect(result.error).toBeUndefined();
  const saved = (await listMessages(db, t, thread.id))[1];
  expect(saved).toMatchObject({ content: "", status: "complete", errorCode: "length_limit" });
  expect(saved?.usage).toMatchObject({ outputTokens: 40, reasoningTokens: 40 });
  // The empty answer is left out of the history the next model sees.
  expect(historyFor(await listMessages(db, t, thread.id))).toHaveLength(1);
});

test("an image goes with its question, and is resent on later turns and on retry", async () => {
  const { db, deps, fakes } = setup({});
  const files = memoryFilesApi();
  const withFiles = { ...deps, files };
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const stored = await files.put(png);
  const file = await addFile(db, t, {
    name: "chart.png",
    mime: "image/png",
    sizeBytes: png.length,
    sha256: stored.sha256,
    width: 800,
    height: 600,
  });
  const thread = await createThread(db, t);

  await sendMessage(withFiles, {
    threadId: thread.id,
    model: claude,
    text: "",
    fileIds: [file.id],
  });
  const image = { kind: "image", mediaType: "image/png", data: toBase64(png) };
  expect(fakes.anthropic.calls[0]).toEqual([{ role: "user", content: "", attachments: [image] }]);
  expect((await getThread(db, t, thread.id))?.title).toBe("Image");

  await sendMessage(withFiles, { threadId: thread.id, model: gpt, text: "And now?" });
  expect(fakes.openai.calls[0]?.[0]).toEqual({ role: "user", content: "", attachments: [image] });

  await retryLast(withFiles, { threadId: thread.id, model: claude });
  expect(fakes.anthropic.calls[1]?.[0]).toEqual({
    role: "user",
    content: "",
    attachments: [image],
  });
});

test("web search: fee added to the cost, sources saved, status reported, only if the model can search", async () => {
  const searchCatalog = parseCatalog({
    price_version: "2026-10-27",
    models: [
      {
        provider: "anthropic",
        id: "searcher",
        display_name: "Searcher",
        context_window: 200000,
        max_output: 1000,
        price: { input: 2, output: 10 },
        capabilities: ["web_search"],
        verified_on: "2026-10-27",
        source_url: "https://example.com",
      },
    ],
    tool_prices: [
      {
        provider: "anthropic",
        tool: "web_search",
        usd_per_call: 0.01,
        verified_on: "2026-10-27",
        source_url: "https://example.com",
      },
    ],
  });
  const searcher = searchCatalog.models[0] as CatalogModel;
  const seenOptions: unknown[] = [];
  const db = openTestDb();
  const deps: ChatDeps = {
    db,
    tenant: t,
    catalog: searchCatalog,
    adapterFor: () => ({
      provider: "anthropic",
      listModels: () => Promise.resolve([]),
      async *streamChat(_h, _m, options) {
        seenOptions.push(options);
        await Promise.resolve();
        yield { type: "status", status: "searching" };
        yield { type: "status", status: null };
        yield { type: "text", text: "It's 1916." };
        yield { type: "citation", url: "https://a.example", title: "A" };
        yield { type: "citation", url: "https://a.example", title: "A" }; // same source again
        yield { type: "citation", url: "https://b.example", title: null };
        yield {
          type: "done",
          usage: {
            inputTokens: 1000,
            outputTokens: 100,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            webSearchCalls: 2,
          },
          usageReported: true,
          stopReason: "end_turn",
          providerRequestId: null,
          attempts: 1,
        };
      },
    }),
  };
  const thread = await createThread(db, t);
  const statuses: unknown[] = [];
  const result = await sendMessage(deps, {
    threadId: thread.id,
    model: searcher,
    text: "When was Shannon born?",
    webSearch: true,
    onStatus: (s) => statuses.push(s),
  });
  // 1,000 × $2 + 100 × $10 per MTok = $0.003, plus 2 searches × $0.01 = $0.023
  expect(result.costMicroUsd).toBe(3000 + 20000);
  expect(seenOptions[0]).toEqual({ webSearch: true });
  expect(statuses).toEqual(["searching", null]);
  const saved = await citationsForMessages(db, t, [result.assistantMessageId]);
  expect(saved.get(result.assistantMessageId)).toEqual([
    { url: "https://a.example", title: "A" },
    { url: "https://b.example", title: null },
  ]);
  expect((await listMessages(db, t, thread.id))[1]?.usage.webSearchCalls).toBe(2);

  // A model without the capability never gets the tool, even if the toggle is on.
  await sendMessage(
    { ...deps, catalog },
    { threadId: thread.id, model: claude, text: "Again", webSearch: true },
  );
});

test("custom instructions go to every model as the system prompt, read fresh on each send", async () => {
  const { db, deps, fakes } = setup({});
  const thread = await createThread(db, t);
  await sendMessage(deps, { threadId: thread.id, model: claude, text: "a" });
  expect(fakes.anthropic.options[0]).toEqual({});

  await setGlobalInstructions(db, t, { aboutYou: "I live in Leeds.", howToAnswer: "Be brief." });
  await setThreadInstructions(db, t, thread.id, "  Answer in French.  ");
  const project = await createProject(db, t, "Trip");
  await updateProject(db, t, project.id, {
    name: "Trip",
    instructions: "Prices in euros.",
    defaultModel: null,
  });
  await setThreadProject(db, t, thread.id, project.id);
  await sendMessage(deps, { threadId: thread.id, model: gpt, text: "b" });
  const system = fakes.openai.options[0]?.system ?? "";
  expect(system).toContain("<about_the_user>\nI live in Leeds.\n</about_the_user>");
  expect(system.indexOf("Be brief.")).toBeLessThan(system.indexOf("Prices in euros."));
  expect(system.indexOf("Prices in euros.")).toBeLessThan(system.indexOf("Answer in French."));
  expect(system).toContain("<this_chat>\nAnswer in French.\n</this_chat>");

  // Retry uses them too.
  await retryLast(deps, { threadId: thread.id, model: claude });
  expect(fakes.anthropic.options[1]?.system).toBe(system);
});
