// @vitest-environment node
import { fakeMemory } from "@/storage/testing/memory";
import { parseCatalog, type CatalogModel, type ProviderId } from "@/catalog/catalog";
import { parsePolicy } from "@/routing/policy";
import { sendMessage } from "@/chat/sendMessage";
import { ProviderError } from "@/providers/errors";
import type { ChatMessage, ChatOptions, ProviderAdapter, StreamEvent } from "@/providers/types";
import { DEFAULT_TENANT } from "@/storage/defaults";
import {
  addDecision,
  blockedBy,
  addMemory,
  approveProposal,
  deleteAllMemories,
  editMemory,
  listMemories,
  listPendingProposals,
  memoriesForMessages,
  rejectProposal,
  type Memory,
} from "@/storage/memories";
import { addMessage, finishMessage, listMessages } from "@/storage/messages";
import { createProject } from "@/storage/projects";
import { listRecentRequests } from "@/storage/requestLog";
import { getMemorySettings, setMemorySettings } from "@/storage/settings";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread, getThread, setThreadMemory, setThreadProject } from "@/storage/threads";
import { EMPTY_USAGE } from "@/storage/usage";
import { housekeepingModel } from "@/chat/housekeeping";
import { needsMemoryCheck, parseSuggestions, suggestMemories, transcript } from "./extract";
import { explainPick, keywords, memoryLine, pickMemories, selectMemories } from "./inject";
import { findSecret } from "./secrets";

const t = DEFAULT_TENANT;
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("expected a value");
  return value;
}
// Placeholder prices for arithmetic; real ones live in data/models.json.
const catalog = parseCatalog({
  price_version: "2026-10-26",
  models: [
    {
      provider: "anthropic",
      id: "big",
      display_name: "Big",
      context_window: 200000,
      max_output: 1000,
      price: { input: 2, output: 10 },
      capabilities: [],
      verified_on: "2026-10-26",
      source_url: "https://example.com",
    },
    {
      provider: "anthropic",
      id: "small-a",
      display_name: "Small A",
      context_window: 200000,
      max_output: 1000,
      price: { input: 0.1, output: 0.5 },
      capabilities: [],
      verified_on: "2026-10-26",
      source_url: "https://example.com",
    },
    {
      provider: "openai",
      id: "small-o",
      display_name: "Small O",
      context_window: 200000,
      max_output: 1000,
      price: { input: 0.1, output: 0.5 },
      capabilities: [],
      verified_on: "2026-10-26",
      source_url: "https://example.com",
    },
  ],
});
const big = catalog.models[0] as CatalogModel;
const small = catalog.models[1] as CatalogModel;

function done(input = 1000, output = 200): StreamEvent {
  return {
    type: "done",
    usage: {
      ...EMPTY_USAGE,
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      webSearchCalls: 0,
    },
    usageReported: true,
    stopReason: "end_turn",
    providerRequestId: "req_m",
    attempts: 1,
  };
}

function fakeAdapter(replies: (string | Error)[]) {
  const calls: { history: ChatMessage[]; options: ChatOptions; model: string }[] = [];
  const queue = [...replies];
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(history, model, options) {
      calls.push({ history, options, model });
      await Promise.resolve();
      const next = queue.shift() ?? "ok";
      if (next instanceof Error) throw next;
      yield { type: "text", text: next };
      yield done();
    },
  };
  return { adapter, calls };
}

async function chatWith(db: ReturnType<typeof openTestDb>, user: string, reply: string) {
  const thread = await createThread(db, t, "Trip planning");
  const q = await addMessage(db, t, {
    threadId: thread.id,
    parentId: null,
    role: "user",
    content: user,
  });
  const a = await addMessage(db, t, {
    threadId: thread.id,
    parentId: q,
    role: "assistant",
    content: "",
    status: "streaming",
  });
  await finishMessage(db, t, a, {
    content: reply,
    status: "complete",
    usage: EMPTY_USAGE,
    errorCode: null,
    errorMessage: null,
    requestId: null,
  });
  return thread;
}

const memory = (id: string, text: string, projectId: string | null = null, createdAt = 1): Memory =>
  fakeMemory({ id, text, projectId, createdAt, updatedAt: createdAt });

describe("secrets filter (PM-05)", () => {
  // Built at runtime so the repo's secret scan never sees a key-shaped literal.
  const key = ["sk", "proj", "A1b2C3d4E5f6G7h8I9j0K1l2M3"].join("-");
  test.each([
    [`My OpenAI key is ${key}`, "api_key"],
    ["AWS key AKIA" + "ABCDEFGHIJKLMNOP", "api_key"],
    ["The token is 9fK2pQ7xLm4Rt8Vw1Yz6Bc3Nd5Gh0Js2Ae", "api_key"],
    ["Wifi password is hunter22", "password"],
    ["My PIN: 4821", "password"],
    ["Card 4111 1111 1111 1111 expires soon", "card_number"],
    ["SSN 123-45-6789", "government_id"],
    ["Passport number X1234567", "government_id"],
    ["IBAN GB33BUKB20201555555555", "account_number"],
    ["Checking account number is 0012345678", "account_number"],
  ])("%s → %s", (text, kind) => {
    expect(findSecret(text)).toBe(kind);
  });
  test.each([
    "Prefers metric units.",
    "Lives in Toronto with his partner and two kids.",
    "Is building FUSE, a desktop chat app, in Tauri 2 and React 19.",
    "Was born in 1984.",
    "Phone is an iPhone 17 Pro.",
    "Works on the password reset flow at work.",
  ])("keeps %s", (text) => {
    expect(findSecret(text)).toBeNull();
  });
});

describe("injection (PM-04)", () => {
  const pool = [
    memory("a", "Has a dog called Biscuit.", null, 1),
    memory("b", "Prefers answers in metric units.", null, 2),
    memory("c", "Works as a nurse in Leeds.", null, 3),
    memory("p", "The FUSE project uses Tauri.", "proj1", 4),
  ];
  test("sends every memory when they all fit, plus the chat's project ones only", () => {
    expect(
      selectMemories(pool, "hello", { projectId: null, threadId: null }, 1500).map((m) => m.id),
    ).toEqual(["a", "b", "c"]);
    expect(
      selectMemories(pool, "hello", { projectId: "proj1", threadId: null }, 1500).map((m) => m.id),
    ).toEqual(["a", "b", "c", "p"]);
  });
  test("over budget: keyword matches win, in saved order", () => {
    const chosen = selectMemories(
      pool,
      "What should I feed my dog Biscuit? Metric please",
      { projectId: null, threadId: null },
      20,
    );
    expect(chosen.map((m) => m.id)).toEqual(["a", "b"]);
    expect(
      selectMemories(pool, "unrelated question", { projectId: null, threadId: null }, 10),
    ).toEqual([]);
  });
  test("a zero budget turns injection off", () => {
    expect(selectMemories(pool, "dog", { projectId: null, threadId: null }, 0)).toEqual([]);
  });
  test("keywords drop stopwords and plurals", () => {
    expect([...keywords("What are the dogs doing in Leeds?")]).toEqual(["dog", "leed"]);
    expect(keywords("A dog in Leeds")).toEqual(keywords("dogs, Leeds"));
  });
});

describe("extraction (PM-03)", () => {
  beforeEach(() => {
    let c = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (c += 10));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("housekeeping uses the Cheap tier's cheapest model with a key, the chat's provider first on a tie", () => {
    const policy = parsePolicy({
      policy_version: "2026-10-28",
      built_from_price_version: "2026-10-26",
      tiers: [
        {
          id: "cheap",
          label: "Cheap",
          description: "-",
          models: ["anthropic/small-a", "openai/small-o"],
        },
        { id: "balanced", label: "Balanced", description: "-", models: ["anthropic/big"] },
        { id: "best", label: "Best", description: "-", models: [] },
      ],
      housekeeping: { title: "cheap", classify: "cheap", memory: "cheap", summary: "cheap" },
      quality_floor: { default: "balanced", overrides: [] },
      rules: [{ id: "default", when: {}, tier: "balanced", reason: "-" }],
    });
    const pick = (providers: ProviderId[], prefer?: ProviderId) =>
      housekeepingModel(policy, catalog, "memory", providers, prefer)?.id;
    expect(pick(["anthropic", "openai"], "openai")).toBe("small-o");
    expect(pick(["anthropic", "openai"], "anthropic")).toBe("small-a");
    expect(pick(["openai"])).toBe("small-o");
    expect(pick([])).toBeUndefined();
  });

  test("parses fenced JSON and drops malformed items", () => {
    const reply =
      'Sure:\n```json\n{"suggestions": [{"op": "add", "text": " Likes  tea. ", "kind": "preference", "confidence": 140},' +
      ' {"op": "update", "text": "no id"}, {"op": "delete", "id": "m2"}, {"op": "explode"}, "x"]}\n```';
    expect(parseSuggestions(reply)).toEqual([
      {
        op: "add",
        ref: null,
        text: "Likes tea.",
        kind: "preference",
        confidence: 100,
        projectOnly: false,
      },
      { op: "delete", ref: "M2", text: "", kind: "fact", confidence: 70, projectOnly: false },
    ]);
    expect(parseSuggestions("nothing here")).toEqual([]);
    expect(parseSuggestions("{not json}")).toEqual([]);
  });

  test("suggests adds, updates and deletes; skips secrets and repeats; logs the cost", async () => {
    const db = openTestDb();
    // Found in earlier chats, so a suggestion may change them (PM-15's authority order).
    const found = { kind: "fact", authority: "extracted" } as const;
    const keep = await addMemory(db, t, { text: "Lives in Leeds.", ...found });
    const old = await addMemory(db, t, { text: "Has one cat.", ...found });
    const thread = await chatWith(db, "We moved to York and got a second cat.", "Congrats!");
    const reply = JSON.stringify({
      suggestions: [
        { op: "update", id: "M1", text: "Lives in York.", kind: "fact", confidence: 90 },
        { op: "delete", id: "M2" },
        { op: "add", text: "Has two cats.", kind: "fact", confidence: 85 },
        { op: "add", text: "has two cats", kind: "fact" },
        { op: "add", text: "Lives in Leeds.", kind: "fact" },
        { op: "add", text: "Door code PIN is 1234", kind: "fact" },
        { op: "update", id: "M9", text: "Unknown target" },
      ],
    });
    const { adapter, calls } = fakeAdapter([reply]);
    const deps = { db, tenant: t, adapterFor: () => adapter };

    const r = await suggestMemories(deps, catalog, thread.id, small);
    // 1,000 × $0.10/MTok + 200 × $0.50/MTok = $0.0001 + $0.0001
    expect(r).toEqual({ proposed: 3, skipped: ["password"], costMicroUsd: 200 });
    expect(calls[0]?.model).toBe("small-a");
    expect(calls[0]?.history[0]?.content).toContain("M1 [fact] Lives in Leeds.");
    expect(calls[0]?.history[0]?.content).toContain("User: We moved to York");

    const pending = await listPendingProposals(db, t);
    expect(pending.map((p) => [p.op, p.text, p.currentText])).toEqual([
      ["update", "Lives in York.", "Lives in Leeds."],
      ["delete", "", "Has one cat."],
      ["add", "Has two cats.", null],
    ]);
    expect(JSON.stringify(pending)).not.toContain("1234");

    const [log] = await listRecentRequests(db, t, 1);
    expect(log).toMatchObject({ purpose: "memory", model: "small-a", threadId: thread.id });
    expect(log?.usage.costMicroUsd).toBe(200);
    expect(needsMemoryCheck(must(await getThread(db, t, thread.id)))).toBe(false);

    // Approve all three: York replaces Leeds (kept as history), the cat fact goes, the new one lands.
    for (const p of pending) await approveProposal(db, t, p.id);
    expect((await listMemories(db, t)).map((m) => m.text)).toEqual([
      "Lives in York.",
      "Has two cats.",
    ]);
    expect(
      db.raw.prepare("SELECT superseded_by_id FROM memories WHERE id = ?").get(keep),
    ).not.toEqual({
      superseded_by_id: null,
    });
    expect(db.raw.prepare("SELECT deleted_at FROM memories WHERE id = ?").get(old)).not.toEqual({
      deleted_at: null,
    });
    expect(await listPendingProposals(db, t)).toEqual([]);
  });

  test("a suggestion never changes or removes what you entered, and never sees a decision (PM-15)", async () => {
    const db = openTestDb();
    const project = await createProject(db, t, "Boat");
    await addMemory(db, t, { text: "Lives in Leeds.", kind: "fact" });
    await addMemory(db, t, { text: "Has one cat.", kind: "fact" });
    await addDecision(db, t, project.id, {
      text: "Moor at the north harbour.",
      rationale: "Cheaper",
      alternatives: [],
    });
    const thread = await chatWith(db, "We moved to York.", "Congrats!");
    await setThreadProject(db, t, thread.id, project.id);
    const reply = JSON.stringify({
      suggestions: [
        { op: "update", id: "M1", text: "Lives in York.", kind: "fact", confidence: 90 },
        { op: "delete", id: "M2" },
      ],
    });
    const { adapter, calls } = fakeAdapter([reply]);
    await suggestMemories({ db, tenant: t, adapterFor: () => adapter }, catalog, thread.id, small);
    expect(calls[0]?.history[0]?.content).not.toContain("north harbour");
    const pending = await listPendingProposals(db, t);
    expect(pending.map((p) => [p.op, p.text, p.memoryId, p.extractionModel])).toEqual([
      ["add", "Lives in York.", null, "small-a"],
    ]);
    // Your fact is still in use; the review shows the new one against it (PM-11).
    expect((await listMemories(db, t)).map((m) => m.text)).toContain("Lives in Leeds.");
  });

  test("rejected suggestions are passed back so they aren't made again", async () => {
    const db = openTestDb();
    const thread = await chatWith(db, "I like jazz.", "Nice.");
    const { adapter, calls } = fakeAdapter([
      '{"suggestions": [{"op": "add", "text": "Likes jazz.", "kind": "preference"}]}',
      '{"suggestions": [{"op": "add", "text": "Likes jazz!", "kind": "preference"}]}',
    ]);
    const deps = { db, tenant: t, adapterFor: () => adapter };
    await suggestMemories(deps, catalog, thread.id, small);
    const [p] = await listPendingProposals(db, t);
    await rejectProposal(db, t, must(p).id);
    const again = await suggestMemories(deps, catalog, thread.id, small);
    expect(again.proposed).toBe(0);
    expect(calls[1]?.history[0]?.content).toContain("<already_suggested>\n- Likes jazz.");
  });

  test("project-only facts are scoped to the chat's project", async () => {
    const db = openTestDb();
    const project = await createProject(db, t, "Garden");
    const thread = await chatWith(db, "The raised beds are 2 m long.", "Got it.");
    await setThreadProject(db, t, thread.id, project.id);
    const { adapter, calls } = fakeAdapter([
      '{"suggestions": [{"op": "add", "text": "Raised beds are 2 m long.", "kind": "constraint", "project_only": true}]}',
    ]);
    await suggestMemories({ db, tenant: t, adapterFor: () => adapter }, catalog, thread.id, small);
    expect(calls[0]?.options.system).toContain('project "Garden"');
    const [p] = await listPendingProposals(db, t);
    await approveProposal(db, t, must(p).id, "Raised beds are 2 metres long.");
    expect(await listMemories(db, t)).toMatchObject([
      {
        text: "Raised beds are 2 metres long.",
        kind: "constraint",
        scope: "project",
        projectId: project.id,
        sourceThreadId: thread.id,
        authority: "extracted",
        extractionMethod: "chat",
      },
    ]);
  });

  test("a failed call is logged, nothing is proposed, and the chat is checked again later", async () => {
    const db = openTestDb();
    const thread = await chatWith(db, "Hi", "Hello");
    const { adapter } = fakeAdapter([
      new ProviderError("overloaded", "Overloaded", { status: 529 }),
    ]);
    const r = await suggestMemories(
      { db, tenant: t, adapterFor: () => adapter },
      catalog,
      thread.id,
      small,
    );
    expect(r.proposed).toBe(0);
    expect(r.error).toContain("Anthropic");
    const [log] = await listRecentRequests(db, t, 1);
    expect(log).toMatchObject({ purpose: "memory", httpStatus: 529 });
    expect(needsMemoryCheck(must(await getThread(db, t, thread.id)))).toBe(true);
  });

  test("a chat with no complete answer is skipped without a call", async () => {
    const db = openTestDb();
    const thread = await createThread(db, t);
    await addMessage(db, t, { threadId: thread.id, parentId: null, role: "user", content: "Hi" });
    const { adapter, calls } = fakeAdapter([]);
    const r = await suggestMemories(
      { db, tenant: t, adapterFor: () => adapter },
      catalog,
      thread.id,
      small,
    );
    expect(r.proposed).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("the transcript keeps the newest turns within the cap", async () => {
    const db = openTestDb();
    const thread = await chatWith(db, "x".repeat(5000), "short answer");
    const text = transcript(await listMessages(db, t, thread.id));
    expect(text).toContain("[…]");
    expect(text).toContain("Assistant: short answer");
  });
});

describe("memories in chat", () => {
  beforeEach(() => {
    let c = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (c += 10));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("saved memories go in the system prompt and are recorded per answer; off per chat", async () => {
    const db = openTestDb();
    await addMemory(db, t, { text: "Prefers metric units.", kind: "preference" });
    const { adapter, calls } = fakeAdapter(["One", "Two"]);
    const deps = { db, tenant: t, catalog, adapterFor: () => adapter };
    const thread = await createThread(db, t);

    const first = await sendMessage(deps, {
      threadId: thread.id,
      model: big,
      text: "How tall is Everest?",
    });
    expect(calls[0]?.options.system).toContain("<memories>");
    expect(calls[0]?.options.system).toContain("- Prefers metric units.");
    const used = await memoriesForMessages(db, t, [first.assistantMessageId]);
    expect(used.get(first.assistantMessageId)?.map((m) => m.text)).toEqual([
      "Prefers metric units.",
    ]);

    await setThreadMemory(db, t, thread.id, false);
    const second = await sendMessage(deps, { threadId: thread.id, model: big, text: "And K2?" });
    expect(calls[1]?.options.system).not.toContain("<memories>");
    expect((await memoriesForMessages(db, t, [second.assistantMessageId])).size).toBe(0);
  });

  test("edit, delete all, and settings round-trip", async () => {
    const db = openTestDb();
    const id = await addMemory(db, t, { text: "Old", kind: "fact", confidence: 40 });
    await editMemory(db, t, id, { text: "  New   text ", kind: "person", projectId: null });
    expect(await listMemories(db, t)).toMatchObject([
      { text: "New text", kind: "person", confidence: 100 },
    ]);
    await deleteAllMemories(db, t);
    expect(await listMemories(db, t)).toEqual([]);

    expect(await getMemorySettings(db, t)).toEqual({ suggest: true, budgetTokens: 1500 });
    await setMemorySettings(db, t, { suggest: false, budgetTokens: 0 });
    expect(await getMemorySettings(db, t)).toEqual({ suggest: false, budgetTokens: 0 });
    await setMemorySettings(db, t, { suggest: true, budgetTokens: 99_999 });
    expect((await getMemorySettings(db, t)).budgetTokens).toBe(8000);
  });
});

test("a memory for one chat is only sent in that chat (PM-13)", () => {
  const pool = [
    fakeMemory({ id: "g", text: "Global" }),
    fakeMemory({ id: "c", text: "Only here", scope: "conversation", threadId: "t1" }),
  ];
  const ids = (threadId: string) =>
    selectMemories(pool, "x", { projectId: null, threadId }, 1500).map((m) => m.id);
  expect(ids("t1")).toEqual(["g", "c"]);
  expect(ids("t2")).toEqual(["g"]);
});

test("decisions and constraints always go first, whatever the budget (PM-15)", () => {
  const pool = [
    fakeMemory({ id: "f", text: "Likes long walks along the coast at dawn." }),
    fakeMemory({ id: "c", text: "Budget is £500.", kind: "constraint" }),
    fakeMemory({
      id: "d",
      text: "Moor at the north harbour.",
      kind: "decision",
      rationale: "Cheaper fees",
      alternatives: ["South quay"],
    }),
  ];
  const chosen = selectMemories(pool, "unrelated", { projectId: null, threadId: null }, 5);
  expect(chosen.map((m) => m.id)).toEqual(["c", "d"]);
  expect(chosen.map(memoryLine)).toEqual([
    "Constraint: Budget is £500.",
    "Decision: Moor at the north harbour. Reason: Cheaper fees Ruled out: South quay",
  ]);
});

test("tasks: what blocks one, and only unfinished ones go as context (PM-16)", () => {
  const a = fakeMemory({ id: "a", text: "Order samples", kind: "task", taskStatus: "doing" });
  const b = fakeMemory({
    id: "b",
    text: "Fit it",
    kind: "task",
    taskStatus: "open",
    dependsOn: ["a", "gone"],
  });
  const c = fakeMemory({ id: "c", text: "Old plan", kind: "task", taskStatus: "dropped" });
  expect(blockedBy(b, [a, b, c]).map((t) => t.id)).toEqual(["a"]);
  expect(blockedBy(b, [{ ...a, taskStatus: "done" }, b])).toEqual([]);
  const sent = selectMemories([a, b, c], "x", { projectId: null, threadId: null }, 1500);
  expect(sent.map(memoryLine)).toEqual([
    "Task (in progress): Order samples",
    "Task (to do): Fit it",
  ]);
});

test("each pick says why: always, all fit, shared words or meaning (PM-17)", () => {
  const pool = [
    fakeMemory({ id: "d", text: "Moor at the north harbour.", kind: "decision" }),
    fakeMemory({ id: "w", text: "Owns a sailing dinghy called Puffin." }),
    fakeMemory({ id: "k", text: "Has a girl, Maya, aged 7." }),
    fakeMemory({ id: "x", text: "Drives an old Volvo estate car every single day." }),
  ];
  const where = { projectId: null, threadId: null };
  expect(pickMemories(pool, "x", where, 1500).map((p) => p.reason)).toEqual([
    "always",
    "all_fit",
    "all_fit",
    "all_fit",
  ]);
  const ranked = pickMemories(pool, "Is the dinghy ready?", where, 40, new Map([["k", 0.8]]));
  expect(ranked.map((p) => [p.memory.id, p.reason])).toEqual([
    ["d", "always"],
    ["w", "keyword"],
    ["k", "meaning"],
  ]);
  expect(explainPick("keyword", ranked[1]?.score ?? null)).toMatch(
    /^shares words with your message \(score \d\.\d\)$/,
  );
});
