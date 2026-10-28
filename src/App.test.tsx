// The real app (storage, keys, chat engine) on an in-memory SQLite DB, with scripted providers.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseCatalog } from "@/catalog/catalog";
import { parsePolicy } from "@/routing/policy";
import { memoryFilesApi } from "@/files/api";
import type { PreparedImage } from "@/files/images";
import { ProviderError } from "@/providers/errors";
import type { ChatMessage, ProviderAdapter, StreamEvent } from "@/providers/types";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { listRecentRequests } from "@/storage/requestLog";
import { DbLockedError } from "@/storage/tauriDb";
import { openTestDb } from "@/storage/testing/nodeDb";
import { listThreads } from "@/storage/threads";
import { searchChats } from "@/storage/search";
import { fakeKeysApi } from "@/test/fakeKeysApi";
import { TITLE_SYSTEM } from "@/chat/title";
import App from "./App";

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
      price: { input: 2, output: 10 },
      capabilities: ["vision", "web_search"],
      verified_on: "2026-10-26",
      source_url: "https://example.com",
    },
    {
      provider: "openai",
      id: "test-gpt",
      display_name: "Test GPT",
      context_window: 400000,
      max_output: 1000,
      price: { input: 1, output: 4 },
      capabilities: ["vision", "web_search"],
      verified_on: "2026-10-26",
      source_url: "https://example.com",
    },
    {
      provider: "anthropic",
      id: "test-best",
      display_name: "Test Best",
      context_window: 200000,
      max_output: 1000,
      price: { input: 10, output: 50 },
      capabilities: ["vision", "web_search"],
      verified_on: "2026-10-26",
      source_url: "https://example.com",
    },
  ],
});

// One model per tier; the shipped tiers are tested against data/ in src/routing.
const policy = parsePolicy({
  policy_version: "2026-10-28",
  built_from_price_version: "2026-10-26",
  tiers: [
    { id: "cheap", label: "Cheap", description: "Test", models: ["openai/test-gpt"] },
    { id: "balanced", label: "Balanced", description: "Test", models: ["anthropic/test-claude"] },
    { id: "best", label: "Best", description: "Hard work", models: ["anthropic/test-best"] },
  ],
  housekeeping: { title: "cheap", classify: "cheap", memory: "cheap", summary: "cheap" },
  quality_floor: { default: "balanced", overrides: [] },
  rules: [
    {
      id: "hard-reasoning",
      when: { intents: ["reasoning"], complexities: ["high"] },
      tier: "best",
      reason: "Hard reasoning starts on Best",
    },
    { id: "default", when: {}, tier: "balanced", reason: "Everyday answers start on Balanced" },
  ],
});

/** jsdom can't decode images: pretend every image is 1024×1024 and keep its bytes. */
const fakePrepare = async (f: File): Promise<PreparedImage> => ({
  bytes: new Uint8Array(await f.arrayBuffer()),
  mime: f.type as PreparedImage["mime"],
  width: 1024,
  height: 1024,
});

type Script = (history: ChatMessage[], signal?: AbortSignal) => AsyncGenerator<StreamEvent>;

async function* answer(text: string): AsyncGenerator<StreamEvent> {
  for (const word of text.split(/(?= )/)) {
    await Promise.resolve();
    yield { type: "text", text: word };
  }
  yield {
    type: "done",
    usage: {
      inputTokens: 1200,
      outputTokens: 400,
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

/** Streams some text, then waits until the user presses Stop. */
async function* untilStopped(_h: ChatMessage[], signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  yield { type: "text", text: "Partial answer" };
  await new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(new ProviderError("aborted", "Aborted"));
    });
  });
}

/** Replies for housekeeping calls (titles, memory), kept apart from the chat scripts. */
interface Chores {
  title?: string[];
  memory?: string[];
}

function setup(
  scripts: Partial<Record<"anthropic" | "openai", Script[]>> = {},
  savedKeys: ("anthropic" | "openai")[] = ["anthropic", "openai"],
  chores: Chores = {},
) {
  const db = openTestDb();
  const keys = fakeKeysApi();
  for (const p of savedKeys) keys.keys.set(p, "fake-value-for-tests-0000");
  const calls: Record<string, ChatMessage[][]> = { anthropic: [], openai: [] };
  const options_: unknown[] = [];
  const choreCalls: { kind: keyof Chores; model: string; input: string }[] = [];
  const adapterFor = (provider: "anthropic" | "openai"): ProviderAdapter => ({
    provider,
    listModels: () => Promise.resolve([]),
    streamChat(history, model, options, signal) {
      const kind: keyof Chores | null =
        options.system === TITLE_SYSTEM
          ? "title"
          : options.system?.startsWith("You keep a short list of lasting facts")
            ? "memory"
            : null;
      if (kind) {
        choreCalls.push({ kind, model, input: history[0]?.content ?? "" });
        // No scripted reply: an empty answer (no title change, nothing to remember).
        return answer(chores[kind]?.shift() ?? "");
      }
      calls[provider]?.push(history);
      options_.push(options);
      const next = scripts[provider]?.shift() ?? (() => answer("Hello there."));
      return next(history, signal);
    },
  });
  const files = memoryFilesApi();
  render(
    <App
      openDb={() => Promise.resolve(db)}
      keysApi={keys.api}
      adapterFor={adapterFor}
      catalog={catalog}
      policy={policy}
      files={files}
      prepareImage={fakePrepare}
    />,
  );
  return { db, keys, calls, options: options_, choreCalls, files, user: userEvent.setup() };
}

const composer = () => screen.findByRole("textbox", { name: "Message" });
const sidebar = () => within(screen.getByRole("navigation", { name: "Conversations" }));

beforeEach(() => {
  localStorage.clear();
});

test("send a message: the answer streams in, then shows model, tokens and cost", async () => {
  const { db, user } = setup();
  await user.type(await composer(), "What is FUSE?{Enter}");

  expect(await screen.findByText("Hello there.")).toBeInTheDocument();
  // 1,200 in × $2 + 400 out × $10 per MTok = $0.0064
  const badge = await screen.findByRole("button", { name: "Cost breakdown for Test Claude" });
  expect(badge).toHaveTextContent("Test Claude·1,200 in / 400 out·$0.0064");
  expect(screen.getByLabelText("Thread total")).toHaveTextContent("$0.0064/1,600 tokens");
  // The thread is saved, titled from the question, with its cost in the sidebar.
  await waitFor(() => {
    expect(sidebar().getByText("What is FUSE?")).toBeInTheDocument();
  });
  expect(sidebar().getByText("$0.0064")).toBeInTheDocument();
  expect(await listThreads(db, DEFAULT_TENANT)).toHaveLength(1);
  const logged = await listRecentRequests(db, DEFAULT_TENANT, 10);
  expect(logged.find((r) => r.purpose === "chat")).toMatchObject({ model: "test-claude" });
});

test("the request log lists every provider call with tokens, cost and errors", async () => {
  const { user } = setup({
    anthropic: [
      () => answer("Hello there."),
      // eslint-disable-next-line require-yield -- fails before streaming anything
      async function* () {
        await Promise.resolve();
        throw new ProviderError("auth", "Invalid bearer token", { status: 401 });
      },
    ],
  });
  await user.type(await composer(), "One{Enter}");
  await screen.findByText("Hello there.");
  await user.type(await composer(), "Two{Enter}");
  await screen.findByRole("alert");

  await user.keyboard("{Control>},{/Control}");
  await user.click(await screen.findByRole("button", { name: /Request log/ }));
  const table = await screen.findByRole("table");
  const rows = within(table).getAllByRole("row").slice(1); // newest first
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent("401 · Invalid bearer token");
  // The chat title is a housekeeping call on the cheapest model, after the first answer.
  expect(rows[1]).toHaveTextContent("Test GPT · chat title");
  expect(rows[2]).toHaveTextContent("Test Claude");
  expect(rows[2]).toHaveTextContent("1,200 / 400");
  expect(rows[2]).toHaveTextContent("$0.0064");
  expect(rows[2]).toHaveTextContent("OK");
});

test("switching model mid-thread: divider shown, the new model gets the whole history", async () => {
  const { calls, user } = setup({ openai: [() => answer("From GPT.")] });
  await user.type(await composer(), "First question{Enter}");
  await screen.findByText("Hello there.");

  await user.keyboard("{Control>}k{/Control}");
  await user.click(await screen.findByRole("button", { name: /Test GPT/ }));
  await user.type(await composer(), "Second question{Enter}");

  expect(await screen.findByText("From GPT.")).toBeInTheDocument();
  expect(screen.getByText("Switched to Test GPT · full history sent")).toBeInTheDocument();
  expect(calls.openai?.[0]).toEqual([
    { role: "user", content: "First question" },
    { role: "assistant", content: "Hello there." },
    { role: "user", content: "Second question" },
  ]);
});

describe("auto routing", () => {
  const modeButton = () => screen.getByRole("button", { name: "Choose model (Ctrl+K)" });
  const HARD =
    "Design the technical architecture and a phased implementation plan for our billing system.";

  test("Auto picks a tier per message; each answer shows tier, rule and what Best would cost", async () => {
    const { db, user } = setup({
      anthropic: [() => answer("Everyday answer."), () => answer("Careful answer.")],
    });
    await composer();
    expect(modeButton()).toHaveTextContent("Auto");
    await user.type(await composer(), "What is FUSE?{Enter}");
    expect(await screen.findByText("Everyday answer.")).toBeInTheDocument();
    // Same 1,200 in / 400 out on Test Best: 1,200 × $10 + 400 × $50 per MTok = $0.032.
    const everyday = await screen.findByRole("button", { name: "Routing: Auto · Balanced" });
    expect(everyday).toHaveTextContent("Auto · Balanced· $0.032 on Best");
    expect(
      screen.getByRole("button", { name: "Cost breakdown for Test Claude" }),
    ).toBeInTheDocument();

    // The button previews Auto's pick while you type.
    await user.type(await composer(), HARD);
    expect(screen.getByLabelText("Auto picks Best")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Careful answer.")).toBeInTheDocument();
    const careful = await screen.findByRole("button", { name: "Routing: Auto · Best" });
    expect(careful).not.toHaveTextContent("on Best");
    expect(
      screen.getByRole("button", { name: "Cost breakdown for Test Best" }),
    ).toBeInTheDocument();

    const chats = (await listRecentRequests(db, DEFAULT_TENANT, 10)).filter(
      (r) => r.purpose === "chat",
    );
    expect(chats.map((r) => [r.model, r.tier, r.routeRuleId])).toEqual([
      ["test-best", "best", "hard-reasoning"],
      ["test-claude", "balanced", "default"],
    ]);
  });

  test("a pinned tier or model sticks to its chat; new chats start on Auto", async () => {
    const { user } = setup({ anthropic: [() => answer("From Best.")] });
    await user.keyboard("{Control>}k{/Control}");
    const picker = within(await screen.findByRole("group", { name: "Routing" }));
    await user.click(picker.getByRole("button", { name: /Best tier/ }));
    expect(modeButton()).toHaveTextContent("Best");
    await user.type(await composer(), "hi{Enter}");
    expect(await screen.findByText("From Best.")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Routing: Pinned · Best" }),
    ).toBeInTheDocument();

    await user.keyboard("{Control>}n{/Control}");
    expect(modeButton()).toHaveTextContent("Auto");
    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByRole("button", { name: /Test GPT/ }));
    expect(modeButton()).toHaveTextContent("Test GPT");

    // Back in the first chat, its pin is still there.
    await user.click(sidebar().getByText("hi"));
    await waitFor(() => {
      expect(modeButton()).toHaveTextContent("Best");
    });
  });
});

test("Try a stronger model re-asks one tier up; both answers stay, later turns use the new one", async () => {
  const { db, calls, user } = setup({
    anthropic: [() => answer("Everyday answer."), () => answer("Careful answer.")],
  });
  await user.type(await composer(), "What is FUSE?{Enter}");
  expect(await screen.findByText("Everyday answer.")).toBeInTheDocument();

  await user.click(await screen.findByRole("button", { name: "Try a stronger model (Best)" }));
  expect(await screen.findByText("Careful answer.")).toBeInTheDocument();
  expect(screen.getByText("Everyday answer.")).toBeInTheDocument();
  expect(screen.getByText("Stronger model: Test Best · same question")).toBeInTheDocument();
  expect(
    await screen.findByRole("button", { name: "Routing: Stronger · Best" }),
  ).toBeInTheDocument();
  // Already on Best: nothing stronger to offer.
  expect(screen.queryByRole("button", { name: /Try a stronger model/ })).not.toBeInTheDocument();
  expect(calls.anthropic?.[1]).toEqual([{ role: "user", content: "What is FUSE?" }]);
  const chat = (await listRecentRequests(db, DEFAULT_TENANT, 10)).find((r) => r.purpose === "chat");
  expect(chat).toMatchObject({ model: "test-best", tier: "best", routeRuleId: "escalation" });

  await user.type(await composer(), "And then?{Enter}");
  expect(await screen.findByText("Hello there.")).toBeInTheDocument();
  expect(calls.anthropic?.[2]).toEqual([
    { role: "user", content: "What is FUSE?" },
    { role: "assistant", content: "Careful answer." },
    { role: "user", content: "And then?" },
  ]);
});

test("answer actions: copy, quote into the composer, thumbs up/down (saved), and a thumbs-down nudges a stronger model", async () => {
  const { db, user } = setup({ anthropic: [() => answer("Everyday answer.")] });
  await user.type(await composer(), "What is FUSE?{Enter}");
  expect(await screen.findByText("Everyday answer.")).toBeInTheDocument();
  const actions = within(await screen.findByRole("group", { name: "Answer actions" }));

  await user.click(actions.getByRole("button", { name: "Copy answer" }));
  expect(await navigator.clipboard.readText()).toBe("Everyday answer.");

  await user.click(actions.getByRole("button", { name: "Quote in reply" }));
  expect(await composer()).toHaveValue("> Everyday answer.\n\n");

  await user.click(actions.getByRole("button", { name: "Good answer" }));
  await waitFor(() => {
    expect(actions.getByRole("button", { name: "Good answer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  await user.click(actions.getByRole("button", { name: "Bad answer" }));
  expect(
    await screen.findByRole("button", { name: "Not right? Try a stronger model (Best)" }),
  ).toBeInTheDocument();
  expect(actions.getByRole("button", { name: "Good answer" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const rows = await db.select<{ feedback: string | null }>(
    "SELECT feedback FROM messages WHERE role = 'assistant'",
  );
  expect(rows.map((r) => r.feedback)).toEqual(["down"]);
});

test("edit a question or regenerate an answer: a new version, with ‹ 1/2 › to flip back", async () => {
  const { user } = setup({
    anthropic: [
      () => answer("First answer."),
      () => answer("Edited answer."),
      () => answer("Fresh answer."),
    ],
  });
  await user.type(await composer(), "Original question{Enter}");
  expect(await screen.findByText("First answer.")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Edit message" }));
  const box = screen.getByRole("textbox", { name: "Edit message" });
  await user.clear(box);
  await user.type(box, "Better question{Enter}");
  expect(await screen.findByText("Edited answer.")).toBeInTheDocument();
  expect(screen.queryByText("First answer.")).not.toBeInTheDocument();
  const questionVersions = within(await screen.findByRole("group", { name: "question versions" }));
  expect(questionVersions.getByText("2/2")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Regenerate answer" }));
  expect(await screen.findByText("Fresh answer.")).toBeInTheDocument();
  const answerVersions = within(await screen.findByRole("group", { name: "answer versions" }));
  expect(answerVersions.getByText("2/2")).toBeInTheDocument();
  await user.click(answerVersions.getByRole("button", { name: "Previous answer" }));
  expect(await screen.findByText("Edited answer.")).toBeInTheDocument();

  // Back to the first question: its own answer comes with it.
  await user.click(
    within(screen.getByRole("group", { name: "question versions" })).getByRole("button", {
      name: "Previous question",
    }),
  );
  expect(await screen.findByText("First answer.")).toBeInTheDocument();
  expect(screen.queryByText("Better question")).not.toBeInTheDocument();
});

test("search across chats opens the chat at the matching message (Ctrl+Shift+F)", async () => {
  const { user } = setup({
    anthropic: [
      () => answer("Cook them at 180C for twelve minutes."),
      () => answer("Every 10,000 miles."),
    ],
  });
  await user.type(await composer(), "Sausages in the air fryer?{Enter}");
  expect(await screen.findByText("Cook them at 180C for twelve minutes.")).toBeInTheDocument();
  await user.keyboard("{Control>}n{/Control}");
  await user.type(await composer(), "Oil change interval?{Enter}");
  expect(await screen.findByText("Every 10,000 miles.")).toBeInTheDocument();

  await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  await user.type(await screen.findByRole("textbox", { name: "Search chats" }), "twelve min");
  const results = within(await screen.findByRole("list", { name: "Search results" }));
  const hit = await results.findByRole("listitem");
  expect(hit).toHaveTextContent("Answer");
  expect(within(hit).getByText("twelve")).toContainHTML("mark");
  await user.click(hit);
  expect(await screen.findByText("Cook them at 180C for twelve minutes.")).toBeInTheDocument();
  expect(screen.queryByText("Every 10,000 miles.")).not.toBeInTheDocument();
});

test("incognito: marked, no memory, not listed or searchable, and gone once you leave", async () => {
  const { db, options, user } = setup({ anthropic: [() => answer("Keep it quiet.")] });
  await composer();
  await user.keyboard("{Control>}{Shift>}n{/Shift}{/Control}");
  expect(screen.getByLabelText("Incognito chat")).toBeInTheDocument();
  expect(screen.getByRole("note")).toHaveTextContent("deleted when you leave it");
  await user.type(await composer(), "Plan a surprise party{Enter}");
  expect(await screen.findByText("Keep it quiet.")).toBeInTheDocument();
  expect(options[0]).not.toHaveProperty("system"); // no memories sent
  expect(sidebar().queryByText("Plan a surprise party")).not.toBeInTheDocument();
  expect(await searchChats(db, DEFAULT_TENANT, "surprise")).toEqual([]);

  await user.keyboard("{Control>}n{/Control}");
  expect(screen.queryByLabelText("Incognito chat")).not.toBeInTheDocument();
  await waitFor(async () => {
    const rows = await db.select<{ n: number }>("SELECT COUNT(*) AS n FROM messages");
    expect(rows[0]?.n).toBe(0);
  });
  expect(await listThreads(db, DEFAULT_TENANT)).toEqual([]);
});

test("Think harder sends maximum effort with the model's full output budget, for one message", async () => {
  const { options, user } = setup({
    anthropic: [() => answer("Deep answer."), () => answer("Normal answer.")],
  });
  await composer();
  const think = screen.getByRole("button", { name: "Think harder" });
  await user.click(think);
  expect(think).toHaveAttribute("aria-pressed", "true");
  await user.type(await composer(), "What is FUSE?{Enter}");
  expect(await screen.findByText("Deep answer.")).toBeInTheDocument();
  expect(options[0]).toMatchObject({ effort: "max", maxOutputTokens: 1000 });
  expect(screen.getByRole("button", { name: "Think harder" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await user.type(await composer(), "And then?{Enter}");
  expect(await screen.findByText("Normal answer.")).toBeInTheDocument();
  expect(options.at(-1)).not.toHaveProperty("effort");
});

test("the usage dashboard shows spend for the period, against the one before, and where it went", async () => {
  const { user } = setup();
  await user.type(await composer(), "What is FUSE?{Enter}");
  expect(await screen.findByText("Hello there.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Usage" }));
  const total = within(await screen.findByRole("region", { name: "Total" }));
  // The answer ($0.0064) plus its title on the cheap model (1,200 × $1 + 400 × $4 = $0.0028).
  await waitFor(() => {
    expect(total.getByText("$0.0092")).toBeInTheDocument();
  });
  expect(total.getByText(/2 provider calls/)).toBeInTheDocument();
  expect(
    within(screen.getByRole("region", { name: "By model" })).getByText("Test Claude"),
  ).toBeInTheDocument();
  const purpose = within(screen.getByRole("region", { name: "By purpose" }));
  expect(purpose.getByText("Answers")).toBeInTheDocument();
  expect(purpose.getByText("Chat titles")).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Today" }));
  expect(screen.getByRole("tab", { name: "Today" })).toHaveAttribute("aria-selected", "true");
  expect(total.getByText("$0.0092")).toBeInTheDocument();
});

test("stop keeps the partial answer, marked Stopped", async () => {
  const { user } = setup({ anthropic: [untilStopped] });
  await user.type(await composer(), "Tell me a long story{Enter}");
  expect(await screen.findByText("Partial answer")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /Stop/ }));
  expect(await screen.findByText("Stopped")).toBeInTheDocument();
  expect(screen.getByText("Partial answer")).toBeInTheDocument();
});

test("an error shows a plain message and Retry gets a new answer", async () => {
  const { user } = setup({
    anthropic: [
      // eslint-disable-next-line require-yield -- fails before streaming anything
      async function* () {
        await Promise.resolve();
        throw new ProviderError("rate_limit", "429", { status: 429 });
      },
      () => answer("Second try worked."),
    ],
  });
  await user.type(await composer(), "Hi{Enter}");
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Anthropic rate limit hit. Try again in a moment.");

  await user.click(within(alert).getByRole("button", { name: /Retry/ }));
  expect(await screen.findByText("Second try worked.")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("no key for the selected provider: composer points to Settings, where the key is saved", async () => {
  const { keys, user } = setup({}, []);
  await user.click(await screen.findByRole("button", { name: /Add an Anthropic key in Settings/ }));

  const card = within(screen.getByRole("region", { name: "Anthropic key" }));
  await user.type(await card.findByLabelText("API key"), "fake-value-for-tests-9z9z");
  await user.click(card.getByRole("button", { name: "Save & test" }));
  expect(await card.findByText("…9z9z")).toBeInTheDocument();
  expect(card.getByRole("status")).toHaveTextContent("Working");
  expect(keys.keys.get("anthropic")).toBe("fake-value-for-tests-9z9z");

  await user.click(screen.getByRole("button", { name: /Back to conversation/ }));
  expect(await composer()).toBeEnabled();
});

test("an invalid key is not saved and the input is cleared", async () => {
  const db = openTestDb();
  const keys = fakeKeysApi(() => "invalid");
  render(
    <App openDb={() => Promise.resolve(db)} keysApi={keys.api} catalog={catalog} policy={policy} />,
  );
  const user = userEvent.setup();
  await user.keyboard("{Control>},{/Control}");

  const card = within(await screen.findByRole("region", { name: "OpenAI key" }));
  const input = await card.findByLabelText("API key");
  await user.type(input, "fake-value-for-tests-0000");
  await user.click(card.getByRole("button", { name: "Save & test" }));
  expect(await card.findByRole("status")).toHaveTextContent("Invalid key");
  expect(keys.keys.has("openai")).toBe(false);
  expect(card.getByLabelText("API key")).toHaveValue("");
  // Key tests are logged like any other provider call (no tokens, no key).
  expect((await listRecentRequests(db, DEFAULT_TENANT, 10))[0]).toMatchObject({
    purpose: "key_test",
    errorCode: "invalid",
  });
});

test("deleting a key asks first", async () => {
  const { keys, user } = setup();
  await user.keyboard("{Control>},{/Control}");
  const card = within(await screen.findByRole("region", { name: "OpenAI key" }));
  await user.click(await card.findByRole("button", { name: "Delete OpenAI key" }));
  expect(keys.keys.has("openai")).toBe(true);
  await user.click(await screen.findByRole("button", { name: "Delete key" }));
  expect(await card.findByLabelText("API key")).toBeInTheDocument();
  expect(keys.keys.has("openai")).toBe(false);
});

test("rename and delete a thread", async () => {
  const { db, user } = setup();
  await user.type(await composer(), "Old name{Enter}");
  await screen.findByText("Hello there.");

  await user.click(screen.getByRole("button", { name: "Conversation actions" }));
  await user.click(await screen.findByRole("menuitem", { name: /Rename chat/ }));
  const title = await screen.findByRole("textbox", { name: "Conversation title" });
  await user.clear(title);
  await user.type(title, "New name{Enter}");
  expect(await sidebar().findByText("New name")).toBeInTheDocument();

  await user.click(sidebar().getByRole("button", { name: "Delete New name" }));
  await user.click(await screen.findByRole("button", { name: "Delete conversation" }));
  expect(await sidebar().findByText("No chats yet")).toBeInTheDocument();
  expect(await listThreads(db, DEFAULT_TENANT)).toHaveLength(0);
});

test("reopening the app reopens the last thread, with its messages and costs", async () => {
  const db = openTestDb();
  const keys = fakeKeysApi();
  keys.keys.set("anthropic", "fake-value-for-tests-0000");
  const props = { openDb: () => Promise.resolve(db), keysApi: keys.api, catalog, policy };
  const adapterFor = () =>
    ({
      provider: "anthropic",
      listModels: () => Promise.resolve([]),
      // No title from the housekeeping call: the chat keeps its question as its name.
      streamChat: (_h, _m, o) => answer(o.system === TITLE_SYSTEM ? "" : "Remember me."),
    }) satisfies ProviderAdapter;
  const first = render(<App {...props} adapterFor={adapterFor} />);
  const user = userEvent.setup();
  await user.type(await composer(), "Save this{Enter}");
  await screen.findByText("Remember me.");
  first.unmount();

  render(<App {...props} adapterFor={adapterFor} />);
  // It reopens on the last thread by itself.
  expect(await screen.findByText("Remember me.")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Save this" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Cost breakdown for Test Claude" }),
  ).toBeInTheDocument();
});

test("a storage error is shown instead of failing silently", async () => {
  render(
    <App
      openDb={() => Promise.reject(new Error("disk full"))}
      keysApi={fakeKeysApi().api}
      catalog={catalog}
      policy={policy}
    />,
  );
  expect(await screen.findByText(/Storage error: Error: disk full/)).toBeInTheDocument();
});

test("shortcuts: Ctrl+N new chat, Ctrl+B sidebar, Ctrl+, settings", async () => {
  const { user } = setup();
  await user.type(await composer(), "Something{Enter}");
  await screen.findByText("Hello there.");

  await user.keyboard("{Control>}n{/Control}");
  expect(
    await screen.findByRole("heading", { name: "What are you working on?" }),
  ).toBeInTheDocument();
  await user.keyboard("{Control>}b{/Control}");
  expect(screen.queryByRole("navigation", { name: "Conversations" })).not.toBeInTheDocument();
  await user.keyboard("{Control>},{/Control}");
  expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
});

test("theme choice applies straight away and is remembered", async () => {
  const { user } = setup();
  await user.keyboard("{Control>},{/Control}");
  await user.click(await screen.findByRole("button", { name: "Dark" }));
  expect(document.documentElement).toHaveClass("dark");
  expect(localStorage.getItem("fuse.theme")).toBe("dark");
  await user.click(screen.getByRole("button", { name: "System" }));
  expect(document.documentElement).not.toHaveClass("dark");
});

test("attach an image: chip with token estimate, then it's sent and shown in the question", async () => {
  const { calls, user } = setup();
  const png = new File([new Uint8Array([137, 80, 78, 71, 9, 9])], "chart.png", {
    type: "image/png",
  });
  await composer();
  await user.upload(screen.getByLabelText("Attach files"), png);

  const chips = within(await screen.findByRole("list", { name: "Attachments" }));
  // Anthropic: ceil(1024/28)² = 37² = 1,369 tokens × $2/MTok ≈ $0.0027 (test catalog price)
  expect(await chips.findByText("~1,369 tokens · $0.0027 per turn")).toBeInTheDocument();
  await user.type(await composer(), "What does this show?{Enter}");

  expect(await screen.findByText("Hello there.")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "chart.png" })).toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "Attachments" })).not.toBeInTheDocument();
  expect(calls.anthropic?.[0]?.[0]).toMatchObject({
    role: "user",
    content: "What does this show?",
    attachments: [{ kind: "image", mediaType: "image/png" }],
  });
});

test("an image can be sent on its own; unsupported files are refused with a reason", async () => {
  const { calls, user } = setup();
  await composer();
  const input = screen.getByLabelText("Attach files");
  // The picker filters types; a drop or paste wouldn't, so check the refusal path too.
  const anyType = userEvent.setup({ applyAccept: false });
  await anyType.upload(input, new File(["MZ"], "setup.exe", { type: "application/x-msdownload" }));
  expect(await screen.findByText(/Unsupported file/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Remove setup.exe" }));

  await user.upload(
    input,
    new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }),
  );
  await screen.findByText(/per turn/);
  await user.click(screen.getByRole("button", { name: /Send message/ }));
  expect(await screen.findByText("Hello there.")).toBeInTheDocument();
  expect(calls.anthropic?.[0]?.[0]).toMatchObject({
    content: "",
    attachments: [{ mediaType: "image/jpeg" }],
  });
});

test("a pinned model without vision can't be sent an image", async () => {
  const db = openTestDb();
  const keys = fakeKeysApi();
  keys.keys.set("anthropic", "fake-value-for-tests-0000");
  const textOnly = parseCatalog({
    price_version: "2026-10-26",
    models: [
      {
        provider: "anthropic",
        id: "text-only",
        display_name: "Text Only",
        context_window: 1000,
        max_output: 100,
        price: { input: 1, output: 1 },
        capabilities: [],
        verified_on: "2026-10-26",
        source_url: "https://example.com",
      },
    ],
  });
  render(
    <App
      openDb={() => Promise.resolve(db)}
      keysApi={keys.api}
      catalog={textOnly}
      policy={policy}
      files={memoryFilesApi()}
      prepareImage={fakePrepare}
    />,
  );
  const user = userEvent.setup();
  await composer();
  // Auto would look for a model that can read images; a pinned model can't change.
  await user.keyboard("{Control>}k{/Control}");
  await user.click(await screen.findByRole("button", { name: /Text Only/ }));
  await user.upload(
    screen.getByLabelText("Attach files"),
    new File([new Uint8Array([1])], "a.png", { type: "image/png" }),
  );
  expect(
    await screen.findByText("Text Only can't read images. Pick another model (Ctrl+K)."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Send message/ })).toBeDisabled();
});

test("a text file is read locally and sent as a named document", async () => {
  const { calls, user } = setup();
  await composer();
  const notes = new File(["# Plan\nShip M1 step 3."], "plan.md", { type: "text/markdown" });
  await user.upload(screen.getByLabelText("Attach files"), notes);
  // 23 characters ≈ 6 tokens
  expect(await screen.findByText(/~6 tokens/)).toBeInTheDocument();
  await user.type(await composer(), "Summarise{Enter}");

  expect(await screen.findByText("Hello there.")).toBeInTheDocument();
  expect(screen.getByTitle("plan.md")).toBeInTheDocument();
  expect(calls.anthropic?.[0]?.[0]).toEqual({
    role: "user",
    content: "Summarise",
    attachments: [{ kind: "text", name: "plan.md", text: "# Plan\nShip M1 step 3." }],
  });
});

test("web search: on by default, toggle per thread, live status, cited sources and the search fee", async () => {
  let release: () => void = () => undefined;
  const searched: Script = async function* () {
    yield { type: "status", status: "searching" };
    await new Promise<void>((r) => {
      release = r;
    });
    yield { type: "status", status: null };
    yield { type: "text", text: "It was 1916." };
    yield { type: "citation", url: "https://www.example.com/shannon", title: "Claude Shannon" };
    yield {
      type: "done",
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        webSearchCalls: 1,
      },
      usageReported: true,
      stopReason: "end_turn",
      providerRequestId: null,
      attempts: 1,
    };
  };
  const { db, options, user } = setup({ anthropic: [searched] });
  await composer();
  const toggle = screen.getByRole("button", { name: "Search the web" });
  // New chats start with search on; it can be turned off and back on before sending.
  expect(toggle).toHaveAttribute("aria-pressed", "true");
  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "true");

  await user.type(await composer(), "When was Shannon born?{Enter}");
  expect(await screen.findByText("Searching the web…")).toBeInTheDocument();
  release();
  expect(await screen.findByText("It was 1916.")).toBeInTheDocument();
  expect(options[0]).toEqual({ webSearch: true });

  const sources = within(await screen.findByRole("navigation", { name: "Sources" }));
  expect(sources.getByRole("link", { name: "Claude Shannon" })).toHaveAttribute(
    "href",
    "https://www.example.com/shannon",
  );
  expect(sources.getByText("example.com")).toBeInTheDocument();
  // No search fee in the test catalog's tool prices, so the cost is tokens only; the count shows.
  expect(screen.getByRole("button", { name: /Cost breakdown/ })).toHaveTextContent("1 search");
  // Remembered on the thread.
  expect((await listThreads(db, DEFAULT_TENANT))[0]?.webSearch).toBe(true);
});

describe("auto-update", () => {
  const updates = (
    prepare: () => Promise<string | null>,
    install = vi.fn(() => Promise.resolve()),
  ) => ({
    api: { version: () => Promise.resolve("0.1.7"), prepare, installAndRestart: install },
    install,
  });
  const renderWith = (api: ReturnType<typeof updates>["api"]) => {
    const db = openTestDb();
    render(
      <App
        openDb={() => Promise.resolve(db)}
        keysApi={fakeKeysApi().api}
        catalog={catalog}
        policy={policy}
        updates={api}
      />,
    );
    return userEvent.setup();
  };

  test("a downloaded update offers a restart, which installs it", async () => {
    const { api, install } = updates(() => Promise.resolve("0.1.8"));
    const user = renderWith(api);
    const bar = within(await screen.findByRole("status", { name: "App update" }));
    expect(bar.getByText(/FUSE 0\.1\.8 is ready/)).toBeInTheDocument();
    await user.click(bar.getByRole("button", { name: "Restart now" }));
    expect(install).toHaveBeenCalledOnce();
  });

  test("a failed install says so and can be retried; Later hides the bar", async () => {
    const install = vi.fn(() => Promise.reject(new Error("disk full")));
    const { api } = updates(() => Promise.resolve("0.1.8"), install);
    const user = renderWith(api);
    const bar = within(await screen.findByRole("status", { name: "App update" }));
    await user.click(bar.getByRole("button", { name: "Restart now" }));
    expect(await bar.findByText(/failed: Error: disk full/)).toBeInTheDocument();
    await user.click(bar.getByRole("button", { name: "Try again" }));
    expect(install).toHaveBeenCalledTimes(2);
    await user.click(bar.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("status", { name: "App update" })).not.toBeInTheDocument();
  });

  test("no update, or an offline check, shows nothing; Settings shows the version", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const user = renderWith(updates(() => Promise.reject(new Error("offline"))).api);
    await composer();
    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    expect(screen.queryByRole("status", { name: "App update" })).not.toBeInTheDocument();
    await user.keyboard("{Control>},{/Control}");
    expect(await screen.findByText(/FUSE 0\.1\.7/)).toBeInTheDocument();
    warn.mockRestore();
  });
});

describe("custom instructions", () => {
  test("set in Settings, shown in the chat's window, sent with every message", async () => {
    const { options, user } = setup();
    await composer();
    await user.keyboard("{Control>},{/Control}");
    const section = within(await screen.findByRole("region", { name: "Custom instructions" }));
    await user.type(section.getByLabelText("About you"), "I live in Leeds.");
    await user.type(section.getByLabelText("How to answer"), "Be brief.");
    await user.click(section.getByRole("button", { name: "Save" }));
    expect(await section.findByText("Saved")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to conversation" }));

    // A new chat: this chat's box is kept as a draft until the first message saves the thread.
    await user.click(await screen.findByRole("button", { name: "Instructions (2 active)" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("I live in Leeds.")).toBeInTheDocument();
    expect(dialog.getByText("Be brief.")).toBeInTheDocument();
    await user.type(dialog.getByLabelText("This chat only"), "Answer in French.");
    await user.click(dialog.getByRole("button", { name: "Save" }));
    expect(dialog.getByText(/tokens added to every message/)).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.type(await composer(), "Hello{Enter}");
    expect(await screen.findByText("Hello there.")).toBeInTheDocument();
    const system = (options[0] as { system?: string }).system ?? "";
    expect(system).toContain("I live in Leeds.");
    expect(system).toContain("<this_chat>\nAnswer in French.\n</this_chat>");
    expect(screen.getByRole("button", { name: "Instructions (3 active)" })).toBeInTheDocument();
  });

  test("Edit in Settings jumps to the global boxes; no instructions sends no system prompt", async () => {
    const { options, user } = setup();
    await user.type(await composer(), "Hi{Enter}");
    expect(await screen.findByText("Hello there.")).toBeInTheDocument();
    expect(options[0]).toEqual({ webSearch: true }); // no `system` key
    await user.click(screen.getByRole("button", { name: "Instructions (none)" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("None set.")).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Edit in Settings" }));
    expect(await screen.findByRole("region", { name: "Custom instructions" })).toBeInTheDocument();
  });
});

describe("auto-title", () => {
  test("after the first answer the cheap model names the chat; a rename by hand sticks", async () => {
    const { db, choreCalls, user } = setup({}, undefined, { title: ['"Lisbon trip with kids."'] });
    await user.type(await composer(), "We're going to Lisbon in May with two kids{Enter}");
    expect(await screen.findByText("Hello there.")).toBeInTheDocument();
    expect(await sidebar().findByText("Lisbon trip with kids")).toBeInTheDocument();
    expect(choreCalls).toMatchObject([{ kind: "title", model: "test-gpt" }]);
    expect(choreCalls[0]?.input).toContain("Lisbon in May");
    const logged = await listRecentRequests(db, DEFAULT_TENANT, 10);
    expect(logged.find((r) => r.purpose === "title")).toMatchObject({ model: "test-gpt" });

    // Later answers don't rename it again.
    await user.type(await composer(), "What about food?{Enter}");
    await waitFor(() => {
      expect(screen.getAllByText("Hello there.")).toHaveLength(2);
    });
    expect(choreCalls.filter((c) => c.kind === "title")).toHaveLength(1);
  });
});

describe("memory", () => {
  test("leaving a chat suggests memories; kept ones are sent with later answers", async () => {
    const suggestion = JSON.stringify({
      suggestions: [
        { op: "add", text: "Lives in York.", category: "fact", confidence: 90 },
        { op: "add", text: "Bike lock PIN is 4821", category: "fact" },
      ],
    });
    // The cheapest model with a key does the housekeeping: Test GPT here.
    const { db, options, user } = setup({}, undefined, { memory: [suggestion] });
    await user.type(await composer(), "We just moved to York.{Enter}");
    expect(await screen.findByText("Hello there.")).toBeInTheDocument();
    await user.keyboard("{Control>}n{/Control}");

    const bar = within(await screen.findByRole("status", { name: "Memory suggestions" }));
    await user.click(await bar.findByRole("button", { name: "Review" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/looked like a password or PIN/)).toBeInTheDocument();
    expect(dialog.queryByDisplayValue(/4821/)).not.toBeInTheDocument();
    expect(dialog.getByDisplayValue("Lives in York.")).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Keep" }));
    expect(await dialog.findByText("No suggestions waiting.")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    const logged = await listRecentRequests(db, DEFAULT_TENANT, 10);
    expect(logged.find((r) => r.purpose === "memory")).toMatchObject({ model: "test-gpt" });

    await user.type(await composer(), "Any good walks nearby?{Enter}");
    expect(await screen.findByText("Hello there.")).toBeInTheDocument();
    const system = (options.at(-1) as { system?: string }).system ?? "";
    expect(system).toContain("- Lives in York.");
    expect(await screen.findByRole("button", { name: "1 memory used" })).toBeInTheDocument();
  });

  test("Settings lists memories by category; secrets are refused; edit and delete", async () => {
    const { user } = setup();
    await composer();
    await user.keyboard("{Control>},{/Control}");
    const section = within(await screen.findByRole("region", { name: "Memory" }));
    expect(section.getByText("No memories yet.")).toBeInTheDocument();

    await user.type(section.getByLabelText("New memory"), "My wifi password is hunter22");
    await user.click(section.getByRole("button", { name: "Add memory" }));
    expect(section.getByText(/looks like a password or PIN/)).toBeInTheDocument();

    await user.clear(section.getByLabelText("New memory"));
    await user.type(section.getByLabelText("New memory"), "Prefers metric units.");
    await user.selectOptions(section.getAllByLabelText("Category")[0] as HTMLElement, "preference");
    await user.click(section.getByRole("button", { name: "Add memory" }));
    const prefs = within(await section.findByRole("list", { name: "Preferences" }));
    expect(prefs.getByText("Prefers metric units.")).toBeInTheDocument();

    await user.click(prefs.getByRole("button", { name: "Edit memory: Prefers metric units." }));
    await user.clear(prefs.getByLabelText("Memory text"));
    await user.type(prefs.getByLabelText("Memory text"), "Prefers metric units and 24h time.");
    await user.click(prefs.getByRole("button", { name: "Save" }));
    expect(await section.findByText("Prefers metric units and 24h time.")).toBeInTheDocument();

    await user.click(
      section.getByRole("button", { name: "Delete memory: Prefers metric units and 24h time." }),
    );
    expect(await section.findByText("No memories yet.")).toBeInTheDocument();
  });
});

describe("projects", () => {
  test("a new project starts a chat in it, on its default model, with its instructions", async () => {
    const { db, calls, options, user } = setup();
    await composer();
    await user.click(screen.getByRole("button", { name: "New project" }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.type(dialog.getByLabelText("Name"), "Trip to Lisbon");
    await user.type(dialog.getByLabelText("Project instructions"), "Prices in euros.");
    await user.selectOptions(dialog.getByLabelText("Default model"), "openai/test-gpt");
    await user.click(dialog.getByRole("button", { name: "Create project" }));

    expect(await screen.findByRole("button", { name: "Project: Trip to Lisbon" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Instructions (1 active)" })).toBeInTheDocument();
    await user.type(await composer(), "Where to eat?{Enter}");
    expect(await screen.findByText("Hello there.")).toBeInTheDocument();
    expect(calls.openai).toHaveLength(1);
    expect((options[0] as { system?: string }).system).toContain(
      "<project>\nPrices in euros.\n</project>",
    );
    const [thread] = await listThreads(db, DEFAULT_TENANT);
    expect(thread?.projectId).not.toBeNull();

    // Shown under the project in the sidebar, not with loose chats.
    const projects = within(sidebar().getByRole("region", { name: "Projects" }));
    expect(projects.getByRole("button", { name: /^Where to eat\?/ })).toBeInTheDocument();
  });

  test("chats move in and out of projects; deleting a project keeps its chats", async () => {
    const { db, user } = setup();
    await user.type(await composer(), "Loose question{Enter}");
    expect(await screen.findByText("Hello there.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New project" }));
    const create = within(await screen.findByRole("dialog"));
    await user.type(create.getByLabelText("Name"), "Work");
    await user.click(create.getByRole("button", { name: "Create project" }));

    // Back to the loose chat, then move it into Work from the chat menu.
    await user.click(sidebar().getByRole("button", { name: /^Loose question/ }));
    await user.click(await screen.findByRole("button", { name: "Conversation actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Work" }));
    await waitFor(async () => {
      expect((await listThreads(db, DEFAULT_TENANT))[0]?.projectId).not.toBeNull();
    });
    expect(await screen.findByRole("button", { name: "Project: Work" })).toBeInTheDocument();

    // Delete the project from its settings: the chat stays, now outside any project.
    await user.click(screen.getByRole("button", { name: "Project: Work" }));
    const edit = within(await screen.findByRole("dialog"));
    await user.click(edit.getByRole("button", { name: "Delete…" }));
    await user.click(edit.getByRole("button", { name: "Delete project" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Project: Work" })).not.toBeInTheDocument();
    });
    const [thread] = await listThreads(db, DEFAULT_TENANT);
    expect(thread?.projectId).toBeNull();
    expect(thread?.title).toBe("Loose question");
  });
});

describe("encrypted database", () => {
  test("a locked database asks for the recovery key, then opens", async () => {
    const db = openTestDb();
    let unlocked = false;
    const unlockDb = vi.fn((key: string) => {
      unlocked = key === "GOOD-KEY";
      return Promise.resolve(unlocked);
    });
    render(
      <App
        openDb={() => (unlocked ? Promise.resolve(db) : Promise.reject(new DbLockedError()))}
        unlockDb={unlockDb}
        keysApi={fakeKeysApi().api}
        catalog={catalog}
        policy={policy}
      />,
    );
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Your chats are locked" })).toBeVisible();
    await user.type(screen.getByLabelText("Recovery key"), "WRONG");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("doesn't open these chats");
    await user.clear(screen.getByLabelText("Recovery key"));
    await user.type(screen.getByLabelText("Recovery key"), "GOOD-KEY");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => {
      expect(unlockDb).toHaveBeenLastCalledWith("GOOD-KEY");
    });
    expect(await screen.findByRole("complementary", { name: "Chat sidebar" })).toBeVisible();
  });

  test("Settings shows the recovery key only when asked, with a copy button", async () => {
    const db = openTestDb();
    const recoveryKey = vi.fn(() => Promise.resolve("ABCDEF01-23456789"));
    render(
      <App
        openDb={() => Promise.resolve(db)}
        recoveryKey={recoveryKey}
        keysApi={fakeKeysApi().api}
        catalog={catalog}
        policy={policy}
      />,
    );
    const user = userEvent.setup();
    await screen.findByRole("complementary", { name: "Chat sidebar" });
    await user.keyboard("{Control>},{/Control}");
    const section = within(await screen.findByRole("region", { name: "Recovery key" }));
    expect(recoveryKey).not.toHaveBeenCalled();
    await user.click(section.getByRole("button", { name: "Show recovery key" }));
    expect(await section.findByText("ABCDEF01-23456789")).toBeInTheDocument();
    await user.click(section.getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe("ABCDEF01-23456789");
    await user.click(section.getByRole("button", { name: "Hide" }));
    expect(section.queryByText("ABCDEF01-23456789")).not.toBeInTheDocument();
  });
});

test("Settings imports the routing test set; a bad file changes nothing", async () => {
  const { user, db } = setup();
  await composer();
  await user.keyboard("{Control>},{/Control}");
  const section = within(await screen.findByRole("region", { name: "Routing test set" }));
  expect(section.getByRole("status")).toHaveTextContent("No prompts yet.");

  const line = (over: Record<string, unknown>) =>
    JSON.stringify({
      prompt: "Hi",
      expected_tier: "balanced",
      intent: "chat",
      complexity: "low",
      notes: "",
      ...over,
    });
  const good = [
    line({}),
    line({
      prompt: "Design the sync engine",
      expected_tier: "best",
      intent: "coding",
      complexity: "high",
    }),
    line({ prompt: "Lets fill the gaps", notes: "The missing context is a data repair." }),
  ].join("\n");
  await user.upload(section.getByLabelText("Test set file"), new File([good], "golden.jsonl"));
  expect(await section.findByText("Imported.")).toBeInTheDocument();
  expect(section.getByRole("status")).toHaveTextContent(
    "3 prompts · 2 Balanced · 1 Best · 1 need earlier context",
  );
  // "Design the sync engine" reads as medium coding: Auto would answer on Balanced.
  const score = within(section.getByLabelText("Auto routing score"));
  expect(score.getByText(/Auto picks the tier you expected for/)).toHaveTextContent(
    "Auto picks the tier you expected for 1 of 2 prompts (50%).",
  );
  expect(score.getByText(/Mid-conversation prompts/)).toHaveTextContent("1 of 1");
  await user.click(score.getByText("Show the 1 it got wrong"));
  expect(score.getByText(/expected Best, got Balanced/)).toBeInTheDocument();

  const bad = [line({}), line({ expected_tier: "cheap" }), "not json"].join("\n");
  await user.upload(section.getByLabelText("Test set file"), new File([bad], "bad.jsonl"));
  const alert = await section.findByRole("alert");
  expect(alert).toHaveTextContent("Line 2: expected_tier can't be cheap");
  expect(alert).toHaveTextContent("Line 3: not valid JSON");
  const rows = await db.select<{ n: number }>("SELECT COUNT(*) AS n FROM golden_prompts");
  expect(rows[0]?.n).toBe(3);
});
