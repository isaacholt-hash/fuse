// @vitest-environment node
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { findModel } from "@/catalog/catalog";
import type { Message } from "@/storage/messages";
import { EMPTY_USAGE } from "@/storage/usage";
import {
  cacheHitRate,
  groupFor,
  messageViews,
  modelOption,
  requestRow,
  withLive,
} from "./viewModels";

const catalog = defaultCatalog;
const sonnet = findModel(catalog, "anthropic", "claude-sonnet-5-5");
if (!sonnet) throw new Error("catalog missing claude-sonnet-5-5");

let n = 0;
const msg = (fields: Partial<Message>): Message => ({
  id: `m${String(++n)}`,
  threadId: "t",
  parentId: null,
  role: "user",
  content: "",
  status: "complete",
  errorCode: null,
  errorMessage: null,
  provider: null,
  model: null,
  usage: EMPTY_USAGE,
  requestId: null,
  route: null,
  bestCostMicroUsd: null,
  escalatedFromId: null,
  feedback: null,
  createdAt: 0,
  updatedAt: 0,
  ...fields,
});
const answer = (provider: string, model: string, fields: Partial<Message> = {}) =>
  msg({ role: "assistant", provider, model, content: "ok", ...fields });

test("sidebar groups follow local calendar days", () => {
  const now = new Date(2026, 9, 27, 9, 0).getTime();
  expect(groupFor(new Date(2026, 9, 27, 0, 5).getTime(), now)).toBe("Today");
  expect(groupFor(new Date(2026, 9, 26, 23, 59).getTime(), now)).toBe("Yesterday");
  expect(groupFor(new Date(2026, 9, 21, 12, 0).getTime(), now)).toBe("Previous 7 days");
  expect(groupFor(new Date(2026, 9, 20, 12, 0).getTime(), now)).toBe("Older");
});

test("model options come from the catalog", () => {
  expect(modelOption(sonnet)).toMatchObject({
    id: "claude-sonnet-5-5",
    providerName: "Anthropic",
    name: "Claude Sonnet 5.5",
    inputPrice: sonnet.price.input,
  });
});

test("cost badge: per-part costs add up to the stored total", () => {
  const usage = {
    ...EMPTY_USAGE,
    inputTokens: 1000,
    cachedInputTokens: 800,
    outputTokens: 400,
    reasoningTokens: 100,
    costMicroUsd: 6080, // $2 × 1000 + $0.1 × 800 + $10 × 400, per MTok
    priceVersion: catalog.priceVersion,
    latencyMs: 2300,
  };
  const [view] = messageViews([answer("anthropic", "claude-sonnet-5-5", { usage })], catalog);
  expect(view?.usage).toEqual({
    freshInput: 1000,
    cachedInput: 800,
    cacheWrite: 0,
    output: 400,
    reasoning: 100,
    webSearchCalls: 0,
    parts: { fresh: 2000, cached: 80, cacheWrite: 0, output: 4000, webSearch: 0 },
    totalMicro: 6080,
    latencyMs: 2300,
  });
});

test("no usage from the provider: cost unknown, never a fake $0", () => {
  const [view] = messageViews([answer("anthropic", "claude-sonnet-5-5")], catalog);
  expect(view?.usage?.totalMicro).toBeNull();
});

test("a divider marks each model switch, not each answer", () => {
  const views = messageViews(
    [
      msg({ content: "a" }),
      answer("anthropic", "claude-sonnet-5-5"),
      msg({ content: "b" }),
      answer("anthropic", "claude-sonnet-5-5"),
      msg({ content: "c" }),
      answer("openai", "gpt-6-luna"),
    ],
    catalog,
  );
  expect(views.map((v) => v.switchLabel).filter(Boolean)).toEqual([
    "Switched to GPT-6 Luna · full history sent",
  ]);
});

test("errors and length-limit notices carry their plain-English text", () => {
  const [failed, cutOff] = messageViews(
    [
      answer("openai", "gpt-6-luna", {
        status: "error",
        content: "",
        errorMessage: "OpenAI rejected the API key. Check it in Settings.",
      }),
      answer("openai", "gpt-6-luna", {
        errorCode: "length_limit",
        errorMessage: "The answer was cut off at the output limit.",
      }),
    ],
    catalog,
  );
  expect(failed).toMatchObject({ error: "OpenAI rejected the API key. Check it in Settings." });
  expect(failed?.usage).toBeUndefined();
  expect(cutOff).toMatchObject({ notice: "The answer was cut off at the output limit." });
});

describe("live answer overlay", () => {
  const live = { threadId: "t", model: sonnet, text: "Hel", userText: "Hi", files: [] };

  test("before the engine saves anything: synthetic question and answer", () => {
    const rows = withLive([], live);
    expect(rows.map((r) => [r.role, r.content, r.status])).toEqual([
      ["user", "Hi", "complete"],
      ["assistant", "Hel", "streaming"],
    ]);
  });

  test("once saved: the live text replaces the saved placeholder", () => {
    const base = [
      msg({ content: "Hi" }),
      answer("anthropic", sonnet.id, { status: "streaming", content: "" }),
    ];
    expect(withLive(base, live).map((r) => r.content)).toEqual(["Hi", "Hel"]);
  });

  test("retry: the failed answer is replaced, the question is not repeated", () => {
    const base = [msg({ content: "Hi" }), answer("anthropic", sonnet.id, { status: "error" })];
    const rows = withLive(base, { ...live, userText: null, after: base[0]?.id ?? null });
    expect(rows.map((r) => [r.role, r.status])).toEqual([
      ["user", "complete"],
      ["assistant", "streaming"],
    ]);
  });

  test("a stronger re-run streams under the answer it re-runs", () => {
    const base = [msg({ content: "Hi" }), answer("anthropic", sonnet.id, { content: "Quick" })];
    const rows = withLive(base, { ...live, userText: null, after: base[1]?.id ?? null });
    expect(rows.map((r) => [r.content, r.status])).toEqual([
      ["Hi", "complete"],
      ["Quick", "complete"],
      ["Hel", "streaming"],
    ]);
  });
});

test("an edited first question replaces the whole path until it's saved", () => {
  const base = [msg({ content: "Hi" }), answer("anthropic", sonnet.id, { content: "Old" })];
  const rows = withLive(base, {
    threadId: "t",
    model: sonnet,
    text: "New answer",
    userText: "Hello instead",
    files: [],
    after: null,
  });
  expect(rows.map((r) => r.content)).toEqual(["Hello instead", "New answer"]);
});

test("an escalated answer is labelled Stronger, under a same-question divider", () => {
  const first = answer("anthropic", sonnet.id);
  const views = messageViews(
    [
      msg({ content: "Hi" }),
      first,
      answer("anthropic", "claude-opus-5-5", {
        escalatedFromId: first.id,
        route: {
          mode: "tier",
          tier: "best",
          ruleId: "escalation",
          reason: "One tier up from Balanced, at your request",
          intent: "chat",
          complexity: "low",
        },
      }),
    ],
    catalog,
  );
  expect(views[2]?.switchLabel).toBe("Stronger model: Claude Opus 5.5 · same question");
  expect(views[2]?.route?.label).toBe("Stronger · Best");
});

describe("request log rows", () => {
  const now = new Date(2026, 9, 27, 15, 0).getTime();
  const base = {
    id: "r1",
    threadId: "t",
    messageId: "m",
    purpose: "chat" as const,
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    attempt: 1,
    usage: EMPTY_USAGE,
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
    providerRequestId: "req_1",
    createdAt: new Date(2026, 9, 27, 14, 2, 37).getTime(),
  };

  test("a priced chat call", () => {
    const usage = {
      ...EMPTY_USAGE,
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 300,
      reasoningTokens: 50,
      costMicroUsd: 5020,
      priceVersion: "2026-10-26",
      latencyMs: 2340,
    };
    expect(requestRow({ ...base, usage, attempt: 2 }, catalog, now)).toMatchObject({
      provider: "Anthropic",
      model: "Claude Sonnet 5.5",
      input: 1200,
      output: 300,
      cached: 200,
      reasoning: 50,
      cost: 5020,
      latency: "2.3 s",
      tone: "ok",
      status: "OK after 2 tries",
      requestId: "req_1",
    });
  });

  test("errors, stops and key tests read plainly", () => {
    const failed = requestRow(
      {
        ...base,
        httpStatus: 401,
        errorCode: "authentication_error",
        errorMessage: "Invalid bearer token",
      },
      catalog,
      now,
    );
    expect(failed).toMatchObject({
      tone: "error",
      status: "401 · Invalid bearer token",
      cost: null,
    });
    expect(requestRow({ ...base, errorCode: "aborted" }, catalog, now)).toMatchObject({
      tone: "stopped",
      status: "Stopped",
    });
    expect(
      requestRow({ ...base, purpose: "key_test", model: "models.list" }, catalog, now),
    ).toMatchObject({ model: "Key test", cost: 0 });
  });

  test("older calls show the date", () => {
    const row = requestRow(
      { ...base, createdAt: new Date(2026, 9, 25, 9, 0).getTime() },
      catalog,
      now,
    );
    expect(row.time).toMatch(/Oct 25/);
  });
});

test("cache hit rate: cached input over all input, across the thread", () => {
  const usage = (input: number, cached: number, write: number) => ({
    ...EMPTY_USAGE,
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteTokens: write,
  });
  expect(cacheHitRate([msg({})])).toBeNull();
  expect(
    cacheHitRate([
      answer("anthropic", sonnet.id, { usage: usage(100, 0, 900) }),
      answer("anthropic", sonnet.id, { usage: usage(100, 900, 0) }),
    ]),
  ).toBe(0.45);
});

test("M10 step 12: chats live in Chat; Code and Work sessions in Code, each with its own empty state", async () => {
  const { areaOf, emptyState, inArea } = await import("./viewModels");
  expect(areaOf("chat")).toBe("chat");
  expect(areaOf("code")).toBe("code");
  expect(areaOf("work")).toBe("code");
  expect(inArea({ kind: "work" }, "code")).toBe(true);
  expect(inArea({ kind: "work" }, "chat")).toBe(false);
  expect(emptyState("chat").heading).toBe("What are you working on?");
  expect(emptyState("code").heading).toBe("Describe a task");
});
