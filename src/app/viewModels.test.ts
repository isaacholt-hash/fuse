// @vitest-environment node
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { findModel } from "@/catalog/catalog";
import type { Message } from "@/storage/messages";
import { EMPTY_USAGE } from "@/storage/usage";
import {
  cacheHitRate,
  estimateMessageMicro,
  groupFor,
  messageViews,
  modelName,
  modelOption,
  requestRow,
  typicalOutputTokens,
  unbookedRunSpend,
  unbookedRunTokens,
  capLeftMicro,
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
  reasoningSummary: null,
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

  test("a streaming answer shows its tier and why from the start", () => {
    const route = {
      mode: "auto" as const,
      tier: "balanced" as const,
      ruleId: "chat",
      reason: "read as chat, low",
      intent: "chat",
      complexity: "low",
    };
    const views = messageViews(withLive([], { ...live, route }), catalog);
    const answer = views.at(-1);
    expect(answer?.status).toBe("streaming");
    expect(answer?.tier).toBe("balanced");
    expect(answer?.route?.label).toBe("Auto · Balanced");
    expect(answer?.live?.costMicro).toBeGreaterThan(0);
  });

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

test("M10 step 13: a row waits, goes, or has a new result, most urgent first", async () => {
  const { threadState, worstState } = await import("./viewModels");
  const none = new Set<string>();
  const run = (status: string, updatedAt = 50) => ({ runId: "r", status, updatedAt });
  const base = { waiting: none, seenAt: 100, createdAt: 10 };
  expect(threadState({ ...base, latest: undefined })).toBeNull();
  expect(threadState({ ...base, latest: run("running") })).toBe("going");
  expect(threadState({ ...base, latest: run("running"), waiting: new Set(["r"]) })).toBe("waiting");
  // Ended before it was last opened: nothing new. After: new.
  expect(threadState({ ...base, latest: run("done", 50) })).toBeNull();
  expect(threadState({ ...base, latest: run("done", 150) })).toBe("unseen");
  // Never opened here (a scheduled task's chat): a result after it was made is new.
  expect(threadState({ ...base, seenAt: null, latest: run("done", 50) })).toBe("unseen");
  // Marked unread.
  expect(threadState({ ...base, seenAt: 0, latest: undefined })).toBe("unseen");
  // A handover on HULK, from this desktop's last look.
  expect(threadState({ ...base, latest: undefined, hulk: ["starting"] })).toBe("going");
  expect(threadState({ ...base, latest: undefined, hulk: ["done", "waiting"] })).toBe("waiting");
  expect(worstState([null, "unseen", "going"])).toBe("going");
  expect(worstState(["unseen", "waiting", "going"])).toBe("waiting");
  expect(worstState([null, null])).toBeNull();
});

test("modelName: a stored provider/id ref reads as the catalog's display name", () => {
  expect(modelName(catalog, "anthropic/claude-sonnet-5-5")).toBe(sonnet.displayName);
  expect(modelName(catalog, "anthropic/not-a-model")).toBe("anthropic/not-a-model");
  expect(modelName(catalog, "Best")).toBe("Best");
});

test("the next-message estimate prices the thread's cache share and its typical answer", () => {
  const price = { input: 3, output: 15, cachedInput: 0.3 };
  // No history: all input at full price plus an 800-token answer.
  expect(estimateMessageMicro(10_000, price, [])).toBe(30_000 + 12_000);
  const history = [
    msg({ role: "user" }),
    answer("anthropic", "claude-sonnet-5-5", {
      usage: { ...EMPTY_USAGE, inputTokens: 1000, cachedInputTokens: 9000, outputTokens: 200 },
    }),
  ];
  expect(typicalOutputTokens(history)).toBe(200);
  // 90% cached: 1000 at $3 + 9000 at $0.30, plus 200 out at $15.
  expect(estimateMessageMicro(10_000, price, history)).toBe(3000 + 2700 + 3000);
});

test("a live run's spend counts until it lands on its message, and only once after", () => {
  const live = answer("anthropic", "claude-sonnet-5-5", { id: "run-msg", status: "streaming" });
  expect(unbookedRunSpend([{ messageId: "run-msg", spentMicroUsd: 1100 }], [live])).toBe(1100);
  const booked = {
    ...live,
    status: "complete" as const,
    usage: { ...EMPTY_USAGE, costMicroUsd: 2200 },
  };
  expect(unbookedRunSpend([{ messageId: "run-msg", spentMicroUsd: 2200 }], [booked])).toBe(0);
  // Continued after it booked: only the new spend is added.
  expect(unbookedRunSpend([{ messageId: "run-msg", spentMicroUsd: 2500 }], [booked])).toBe(300);
  expect(unbookedRunSpend([{ messageId: null, spentMicroUsd: 400 }], [])).toBe(400);
});

test("cap left leaves out what running parallel work has set aside", () => {
  const held = (id: string) => (id === "p" ? 83_600 : 0);
  const runs = [
    { id: "p", status: "running" },
    { id: "q", status: "done" },
  ];
  expect(capLeftMicro(5_000_000, 2_200, runs, held)).toBe(4_914_200);
  expect(capLeftMicro(5_000_000, 2_200, [{ id: "p", status: "done" }], held)).toBe(4_997_800);
  expect(capLeftMicro(50_000, 2_200, runs, held)).toBe(0);
});

test("a live run's tokens count in the head until its message carries them", () => {
  const live = answer("anthropic", "claude-sonnet-5-5", { id: "run-msg", status: "streaming" });
  const run = {
    run: { messageId: "run-msg" },
    steps: [{ kind: "model", tokens: 1200 }, { kind: "tool" }, { kind: "model", tokens: 300 }],
  };
  expect(unbookedRunTokens([run], [live])).toBe(1500);
  const booked = { ...live, usage: { ...EMPTY_USAGE, inputTokens: 1000, outputTokens: 500 } };
  expect(unbookedRunTokens([run], [booked])).toBe(0);
});
