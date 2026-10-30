// The real app (storage, keys, chat engine) on an in-memory SQLite DB, with scripted providers.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { parseCatalog } from "@/catalog/catalog";
import { parsePolicy } from "@/routing/policy";
import { memoryFilesApi } from "@/files/api";
import type { RepoApi } from "@/repo/api";
import type { PreparedImage } from "@/files/images";
import { ProviderError } from "@/providers/errors";
import type { ChatMessage, ProviderAdapter, StreamEvent } from "@/providers/types";
import { getSetting, setSetting } from "@/storage/settings";
import { addMemory, addProposals } from "@/storage/memories";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { listRecentRequests } from "@/storage/requestLog";
import { DbLockedError } from "@/storage/tauriDb";
import { openTestDb } from "@/storage/testing/nodeDb";
import { listThreads } from "@/storage/threads";
import { searchChats } from "@/storage/search";
import { fakeKeysApi } from "@/test/fakeKeysApi";
import { TITLE_SYSTEM } from "@/chat/title";
import { CLASSIFY_SYSTEM } from "@/routing/classifyFallback";
import App from "./App";
import { deleteAllData } from "@/data/deleteAll";
import type { BackupInfo } from "@/data/backups";
import { ARTIFACT_GUIDE } from "@/artifacts/parse";

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
  embedding_models: [
    {
      provider: "openai",
      id: "test-embed",
      dimensions: 3,
      max_input_tokens: 8000,
      input_price: 0.02,
      verified_on: "2026-10-28",
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
  /** RT-02's second opinion from the Cheap tier. */
  classify?: string[];
}

function setup(
  scripts: Partial<Record<"anthropic" | "openai", Script[]>> = {},
  savedKeys: ("anthropic" | "openai")[] = ["anthropic", "openai"],
  chores: Chores = {},
  { helloAvailable = false, repo = noRepo }: { helloAvailable?: boolean; repo?: RepoApi } = {},
) {
  const db = openTestDb();
  const keys = fakeKeysApi();
  for (const p of savedKeys) keys.keys.set(p, "fake-value-for-tests-0000");
  const calls: Record<string, ChatMessage[][]> = { anthropic: [], openai: [] };
  const options_: unknown[] = [];
  const choreCalls: { kind: keyof Chores; model: string; input: string }[] = [];
  // What each provider's model list returns (MM-03); empty means "couldn't read it".
  const remote: Record<"anthropic" | "openai", { id: string; displayName: string | null }[]> = {
    anthropic: [],
    openai: [],
  };
  const adapterFor = (provider: "anthropic" | "openai"): ProviderAdapter => ({
    provider,
    listModels: () => Promise.resolve(remote[provider]),
    // A toy embedding for retrieval tests: how often "apple", "boat" and "cloud" appear.
    ...(provider === "openai"
      ? {
          embed: (texts: string[]) =>
            Promise.resolve({
              vectors: texts.map((t) =>
                Float32Array.from(
                  ["apple", "boat", "cloud"].map((w) => t.split(w).length - 1 + 0.01),
                ),
              ),
              tokens: texts.join(" ").length / 4,
              providerRequestId: null,
              attempts: 1,
            }),
        }
      : {}),
    streamChat(history, model, options, signal) {
      const kind: keyof Chores | null =
        options.system === TITLE_SYSTEM
          ? "title"
          : options.system === CLASSIFY_SYSTEM
            ? "classify"
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
  // Times the app asked to start over (delete-all).
  const restarts: number[] = [];
  // The global shortcut (CH-08): what was registered, and a way to "press" it.
  const zooms: number[] = [];
  // Windows Hello (SE-03): set up or not, and the prompts it was asked to show.
  const hello = {
    asks: [] as string[],
    available: () => Promise.resolve(helloAvailable),
    verify: (message: string) => {
      hello.asks.push(message);
      return Promise.resolve(true);
    },
  };
  // Whether each preview page was allowed the listed CDNs (AR-05).
  const previewCdn: boolean[] = [];
  const quick = {
    registered: [] as (string | null)[],
    press: (): void => undefined,
    set(shortcut: string | null) {
      quick.registered.push(shortcut);
      return Promise.resolve({ shortcut, mayNotWork: false });
    },
    onCapture(run: () => void) {
      quick.press = run;
      return Promise.resolve(() => undefined);
    },
  };
  // Database backups (PL-11): what's listed, and the restores asked for.
  const backups = {
    list: [] as BackupInfo[],
    restored: [] as string[],
    api: {
      list: () => Promise.resolve([...backups.list]),
      backupNow: () => {
        const made: BackupInfo = {
          name: `fuse-${String(1_800_000_000_000 + backups.list.length)}-manual.db`,
          createdMs: 1_800_000_000_000,
          bytes: 2 * 1024 * 1024,
          reason: "manual",
        };
        backups.list.unshift(made);
        return Promise.resolve(made);
      },
      restore: (name: string) => {
        backups.restored.push(name);
        return Promise.resolve();
      },
      checkFiles: () => Promise.resolve({ checked: 3, missing: ["a".repeat(64)], changed: [] }),
    },
  };
  // Files handed to "Save as…" (AR-04).
  const saves: { name: string; bytes: Uint8Array }[] = [];
  // Pages handed to the preview scheme (AR-05).
  const previews: string[] = [];
  // Pages for pasted links (FK-06): canned HTML, counted so the 24-hour cache can be checked.
  const web = {
    reads: [] as string[],
    fetch(url: string) {
      web.reads.push(url);
      return Promise.resolve({
        url,
        contentType: "text/html",
        body: "<html><head><title>Atlas service</title></head><body><nav>Menu</nav><article><p>Change the oil every 10,000 miles.</p></article></body></html>",
        truncated: false,
      });
    },
  };
  render(
    <App
      openDb={() => Promise.resolve(db)}
      keysApi={keys.api}
      adapterFor={adapterFor}
      catalog={catalog}
      policy={policy}
      files={files}
      prepareImage={fakePrepare}
      web={web}
      quickCapture={quick}
      hello={hello}
      zoom={(scale) => {
        zooms.push(scale);
        return Promise.resolve();
      }}
      onRestart={() => {
        restarts.push(Date.now());
      }}
      backups={backups.api}
      repo={repo}
      exporter={{
        save: (name: string, bytes: Uint8Array) => {
          saves.push({ name, bytes });
          return Promise.resolve(name);
        },
      }}
      preview={{
        url: (html: string, options?: { cdn?: boolean }) => {
          previews.push(html);
          previewCdn.push(options?.cdn ?? false);
          return Promise.resolve(`preview://localhost/p${String(previews.length)}`);
        },
      }}
    />,
  );
  return {
    db,
    keys,
    calls,
    options: options_,
    choreCalls,
    files,
    web,
    previews,
    previewCdn,
    saves,
    quick,
    zooms,
    hello,
    remote,
    restarts,
    backups,
    user: userEvent.setup(),
  };
}

const composer = () => screen.findByRole("textbox", { name: "Message" });

/** No repository: every call fails, as Rust's would without a linked folder. */
const noRepo: RepoApi = {
  pick: () => Promise.resolve(null),
  check: () => Promise.reject(new Error("unused")),
  write: () => Promise.reject(new Error("read-only in this test")),
  remove: () => Promise.reject(new Error("read-only in this test")),
  move: () => Promise.reject(new Error("read-only in this test")),
  list: () => Promise.reject(new Error("This project has no linked folder.")),
  read: () => Promise.reject(new Error("This project has no linked folder.")),
  search: () => Promise.reject(new Error("This project has no linked folder.")),
};
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
  expect(options[0]).toHaveProperty("system", ARTIFACT_GUIDE); // only the app guide: no memories
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

test("budgets: alerts as spend crosses them, and over the limit a message asks first", async () => {
  const { user } = setup({
    anthropic: [() => answer("First."), () => answer("Second.")],
  });
  await composer();
  await user.keyboard("{Control>},{/Control}");
  const budgets = within(await screen.findByRole("region", { name: "Budgets" }));
  await user.selectOptions(budgets.getByLabelText("Budget period"), "day");
  await user.type(budgets.getByLabelText("Budget limit in dollars"), "0.005");
  await user.click(budgets.getByRole("button", { name: "Add budget" }));
  expect(await budgets.findByText(/\$0\.005 a day/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Back to conversation/ }));

  // $0.0064 answer + $0.0028 title = $0.0092: past the $0.005 budget.
  await user.type(await composer(), "What is FUSE?{Enter}");
  expect(await screen.findByText("First.")).toBeInTheDocument();
  expect(
    await screen.findByText(/Everything: .* this day \(\d+%\)\. Messages now ask before sending\./),
  ).toBeInTheDocument();

  await user.type(await composer(), "And then?{Enter}");
  const ask = within(await screen.findByRole("dialog"));
  expect(ask.getByText(/Everything: \$0\.0092 of \$0\.005 this day/)).toBeInTheDocument();
  await user.click(ask.getByRole("button", { name: "Send anyway" }));
  expect(await screen.findByText("Second.")).toBeInTheDocument();
});

test("a big message shows its cost first; it can go without its files", async () => {
  const { calls, user } = setup({ anthropic: [() => answer("Read it.")] });
  await composer();
  const big = new File(["word ".repeat(30_000)], "book.txt", { type: "text/plain" });
  await user.upload(screen.getByLabelText("Attach files"), big);
  expect(await screen.findByText(/tokens ·/)).toBeInTheDocument();
  // Big text files are searched by default; sent whole, they show their cost first.
  await user.click(
    within(screen.getByRole("group", { name: "How book.txt is sent" })).getByRole("button", {
      name: "Whole",
    }),
  );
  await user.type(await composer(), "Summarize this{Enter}");
  const ask = within(await screen.findByRole("dialog"));
  expect(ask.getByText(/This adds about [\d,]+ tokens\. On Test Claude/)).toBeInTheDocument();
  await user.click(ask.getByRole("button", { name: "Send without the files" }));
  expect(await screen.findByText("Read it.")).toBeInTheDocument();
  expect(calls.anthropic?.[0]).toEqual([{ role: "user", content: "Summarize this" }]);
});

test("the savings card compares this month with Best and with your subscriptions", async () => {
  const { user } = setup();
  await user.type(await composer(), "What is FUSE?{Enter}");
  expect(await screen.findByText("Hello there.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Usage" }));
  const card = within(await screen.findByRole("region", { name: "Savings" }));
  // $0.0064 answer + $0.0028 title spent; the answer on Test Best would be $0.032.
  expect(await card.findByText("$0.0092")).toBeInTheDocument();
  expect(card.getByText(/Routing saved \$0\.0256/)).toBeInTheDocument();
  await user.type(card.getByLabelText("Subscriptions per month in dollars"), "40");
  await user.tab();
  expect(await card.findByText(/less than your subscriptions so far/)).toBeInTheDocument();
});

test("a large text file is searched: the question gets the matching excerpts, and the answer cites them", async () => {
  const { calls, user } = setup({ anthropic: [() => answer("Boats float.")] });
  await composer();
  const text = [
    ...Array.from(
      { length: 400 },
      (_, i) => `Line ${String(i)} about apple orchards and apple pie.`,
    ),
    "The boat sails at dawn from the boat harbour.",
    ...Array.from(
      { length: 400 },
      (_, i) => `Line ${String(i)} about cloud cover and cloud types.`,
    ),
  ].join("\n");
  // Repeat to pass the 20K-token line where files are searched by default.
  const big = new File([`${text}\n`.repeat(4)], "notes.txt", { type: "text/plain" });
  await user.upload(screen.getByLabelText("Attach files"), big);
  expect(await screen.findByText(/searched: the best/)).toBeInTheDocument();
  await user.type(await composer(), "When does the boat sail?{Enter}");
  expect(await screen.findByText("Boats float.")).toBeInTheDocument();

  const sent = calls.anthropic?.[0]?.[0];
  const excerpts = sent?.attachments?.find(
    (a) => a.kind === "text" && a.name === "Excerpts from your files",
  );
  expect(excerpts && "text" in excerpts ? excerpts.text : "").toContain("The boat sails at dawn");
  // The whole file isn't sent: just a note that it's searched.
  const note = sent?.attachments?.find((a) => a.kind === "text" && a.name === "notes.txt");
  expect(note && "text" in note ? note.text : "").toMatch(/isn't sent whole/);
  const cited = within(await screen.findByLabelText("From your files and chats"));
  expect(cited.getAllByText(/notes\.txt, lines \d+–\d+/).length).toBeGreaterThan(0);

  // FK-10: a citation opens the file at the cited lines, highlighted.
  const [source] = cited.getAllByRole("button", { name: /notes\.txt, lines/ });
  if (!source) throw new Error("no citation to open");
  await user.click(source);
  const panel = within(await screen.findByRole("complementary", { name: "File: notes.txt" }));
  const marked = panel.getByLabelText("File text").querySelectorAll("[data-cited]");
  expect(marked.length).toBeGreaterThan(0);
  await user.click(panel.getByRole("button", { name: "Close file" }));
  // The attachment chip on the question opens it too.
  await user.click(screen.getByRole("button", { name: "Open notes.txt" }));
  expect(await screen.findByRole("complementary", { name: "File: notes.txt" })).toBeInTheDocument();
});

test("artifacts across chats: found by search, attached to another chat as context, or opened", async () => {
  const { calls, user } = setup({
    anthropic: [
      () =>
        answer(
          '<artifact id="plan" type="markdown" title="Orchard plan"># Orchard\nPlant apples in March.</artifact>',
        ),
      () => answer("Using your plan."),
    ],
  });
  await user.type(await composer(), "Plan my orchard{Enter}");
  await screen.findByRole("complementary", { name: "Artifact: Orchard plan" });
  await user.click(screen.getByRole("button", { name: /^New chat/ }));

  await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  await user.type(await screen.findByRole("textbox", { name: "Search chats" }), "apples");
  const results = within(await screen.findByRole("list", { name: "Search results" }));
  expect(await results.findByText("Orchard plan")).toBeInTheDocument();
  await user.click(results.getByRole("button", { name: "Attach Orchard plan to this chat" }));
  expect(await screen.findByText("Orchard plan")).toBeInTheDocument();
  await user.type(await composer(), "When do I plant?{Enter}");
  await screen.findByText("Using your plan.");
  const attached = calls.anthropic?.[1]
    ?.at(-1)
    ?.attachments?.find((x) => x.kind === "text" && x.name === "Orchard plan");
  expect(attached && "text" in attached ? attached.text : "").toContain("Plant apples in March.");

  await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  await user.type(await screen.findByRole("textbox", { name: "Search chats" }), "apples");
  await user.click(
    await within(await screen.findByRole("list", { name: "Search results" })).findByText(
      "Orchard plan",
    ),
  );
  expect(
    await screen.findByRole("complementary", { name: "Artifact: Orchard plan" }),
  ).toBeInTheDocument();
});

test("spend caps: past a key's daily cap FUSE stops calling it, until raised for today", async () => {
  const { user, calls } = setup({
    anthropic: [() => answer("First."), () => answer("After the raise.")],
  });
  await composer();
  await user.keyboard("{Control>},{/Control}");
  const caps = within(await screen.findByRole("region", { name: "Spend caps" }));
  const anthropic = within(caps.getByLabelText("Anthropic cap"));
  await user.type(anthropic.getByLabelText("Anthropic daily cap"), "0.001");
  await user.click(anthropic.getByRole("button", { name: "Save" }));
  await user.click(screen.getByRole("button", { name: "Back to conversation" }));

  // $0.0064 goes past the $0.001 cap.
  await user.type(await composer(), "Hello{Enter}");
  await screen.findByText("First.");
  const notice = await screen.findByLabelText("Spend cap notice");
  expect(notice).toHaveTextContent("Anthropic has reached its daily cap ($0.0064 of $0.001)");
  await user.type(await composer(), "Again{Enter}");
  expect(await screen.findByText(/No model at Balanced or above/)).toBeInTheDocument();
  expect(calls.anthropic).toHaveLength(1);

  await user.click(within(notice).getByRole("button", { name: "Raise for today" }));
  await waitFor(() => {
    expect(screen.queryByLabelText("Spend cap notice")).not.toBeInTheDocument();
  });
  await user.type(await composer(), "Again{Enter}");
  expect(await screen.findByText("After the raise.")).toBeInTheDocument();
});

test("model defaults: a tier's max output, effort and prompt prefix go with its requests", async () => {
  const { options, user } = setup();
  await composer();
  await user.keyboard("{Control>},{/Control}");
  const section = within(await screen.findByRole("region", { name: "Model defaults" }));
  expect(section.getByLabelText("Defaults for")).toHaveValue("tier:balanced");
  await user.type(section.getByLabelText("Max output tokens"), "512");
  await user.selectOptions(section.getByLabelText("Reasoning effort"), "low");
  await user.type(section.getByLabelText("Prompt prefix"), "Use British spelling.");
  await user.click(section.getByRole("button", { name: "Save" }));
  expect(await section.findByText("Set for: Balanced tier")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back to conversation" }));
  await user.type(await composer(), "Hello{Enter}");
  await screen.findByText("Hello there.");
  expect(options.at(-1)).toMatchObject({ maxOutputTokens: 512, effort: "low" });
  expect((options.at(-1) as { system?: string }).system).toMatch(/^Use British spelling\.\n\n/);
});

test("a file with secrets: flagged on the chip, sending waits, and the lines can be removed", async () => {
  const { calls, user } = setup({ anthropic: [() => answer("Noted.")] });
  await composer();
  const file = new File(
    ["server: example.com\npassword: hunter2hunter2\nport: 22\n"],
    "setup.txt",
    {
      type: "text/plain",
    },
  );
  await user.upload(screen.getByLabelText("Attach files"), file);
  const flag = (await screen.findByText(/Secrets\?/)).closest("[role=alert]") as HTMLElement;
  expect(flag).toHaveTextContent("Secrets? a password or PIN (1 line)");
  await user.type(await composer(), "Check this");
  expect(screen.getByRole("button", { name: "Send message (Enter)" })).toBeDisabled();
  await user.click(within(flag).getByRole("button", { name: "Remove those lines" }));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Send message (Enter)" })).toBeEnabled();
  });
  await user.click(screen.getByRole("button", { name: "Send message (Enter)" }));
  await screen.findByText("Noted.");
  const sent = calls.anthropic?.[0]?.[0]?.attachments?.find(
    (a) => a.kind === "text" && a.name === "setup.txt",
  );
  const text = sent && "text" in sent ? sent.text : "";
  expect(text).toContain("[line removed by FUSE: it looked like a secret]");
  expect(text).not.toContain("hunter2");
});

test("a pasted link is read as text, attached with its size, and not read again within a day", async () => {
  const { calls, web, user } = setup({
    anthropic: [() => answer("Every 10,000 miles."), () => answer("Yes.")],
  });
  const box = await composer();
  await user.click(box);
  await user.paste("https://www.vw.com/atlas");
  expect(await screen.findByText("Atlas service (vw.com)")).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Attachments" })).toHaveTextContent(
    /~21 tokens · <\$0\.0001 per turn/,
  );
  await user.type(box, "{Enter}");
  expect(await screen.findByText("Every 10,000 miles.")).toBeInTheDocument();
  const page = calls.anthropic?.[0]?.[0]?.attachments?.[0];
  expect(page && "text" in page ? page.text : "").toContain("Change the oil every 10,000 miles.");
  expect(page && "text" in page ? page.text : "").not.toContain("Menu");

  await user.click(await composer());
  await user.paste("https://www.vw.com/atlas");
  expect(
    await within(await screen.findByRole("list", { name: "Attachments" })).findByText(
      "Atlas service (vw.com)",
    ),
  ).toBeInTheDocument();
  expect(web.reads).toEqual(["https://www.vw.com/atlas"]);
});

test("an artifact shows as a card, opens in the side panel, and the same id makes version 2", async () => {
  const doc = (body: string) =>
    `Here's the plan.\n<artifact id="trip" type="markdown" title="Lisbon trip">\n# Day 1\n${body}\n</artifact>\nEnjoy!`;
  const { user } = setup({
    anthropic: [() => answer(doc("Tram 28.")), () => answer(doc("Tram 28, then Belém."))],
  });
  await user.type(await composer(), "Plan my trip{Enter}");
  expect(await screen.findByText("Enjoy!")).toBeInTheDocument();
  const panel = within(await screen.findByRole("complementary", { name: "Artifact: Lisbon trip" }));
  expect(panel.getByText("Tram 28.")).toBeInTheDocument();
  expect(panel.getByText(/version 1/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open Lisbon trip" })).toBeInTheDocument();

  await user.type(await composer(), "Add Belém{Enter}");
  expect(await screen.findByText("Tram 28, then Belém.")).toBeInTheDocument();
  expect(screen.getByText(/version 2/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close artifact" }));
  expect(screen.queryByRole("complementary", { name: /Artifact:/ })).not.toBeInTheDocument();
  await user.click(screen.getAllByRole("button", { name: "Open Lisbon trip" })[0] as HTMLElement);
  expect(
    await screen.findByRole("complementary", { name: "Artifact: Lisbon trip" }),
  ).toBeInTheDocument();
});

test("artifact versions: pick one, diff, restore, and your edits go back to the model", async () => {
  const doc = (body: string) =>
    `<artifact id="note" type="markdown" title="Note">\n${body}\n</artifact>\nDone.`;
  const { options, user } = setup({
    anthropic: [() => answer(doc("Alpha")), () => answer(doc("Beta")), () => answer("Noted.")],
  });
  await user.type(await composer(), "Write a note{Enter}");
  await screen.findByRole("complementary", { name: "Artifact: Note" });
  await user.type(await composer(), "Change it{Enter}");
  const panel = within(await screen.findByRole("complementary", { name: "Artifact: Note" }));
  expect(await panel.findByText("Beta")).toBeInTheDocument();

  await user.selectOptions(panel.getByLabelText("Compare with"), "1");
  const changes = panel.getByLabelText("Changes");
  expect(changes).toHaveTextContent("−Alpha");
  expect(changes).toHaveTextContent("+Beta");

  await user.selectOptions(panel.getByLabelText("Version"), "1");
  expect(panel.getByText("Alpha")).toBeInTheDocument();
  await user.click(panel.getByRole("button", { name: /Restore/ }));
  expect(await panel.findByText(/version 3/)).toBeInTheDocument();
  expect(panel.getByText("Alpha")).toBeInTheDocument();

  await user.click(panel.getByRole("button", { name: "Edit artifact" }));
  const box = panel.getByLabelText("Artifact content");
  await user.clear(box);
  await user.type(box, "Gamma");
  await user.click(panel.getByRole("button", { name: "Save as a new version" }));
  expect(await panel.findByText(/version 4/)).toBeInTheDocument();
  expect(panel.getByText("Gamma")).toBeInTheDocument();

  await user.type(await composer(), "Thanks{Enter}");
  expect(await screen.findByText("Noted.")).toBeInTheDocument();
  const system = (options.at(-1) as { system?: string }).system ?? "";
  expect(system).toContain("<edited_artifacts>");
  expect(system).toContain('<artifact id="note" type="markdown" title="Note">\nGamma\n</artifact>');
});

test("Ask AI to edit: the request routes like a message and the result shows as a diff", async () => {
  const doc = (body: string) =>
    `<artifact id="note" type="markdown" title="Note">\n${body}\n</artifact>\nDone.`;
  const { calls, user } = setup({
    anthropic: [() => answer(doc("Hello world")), () => answer(doc("Hello there, friend"))],
  });
  await user.type(await composer(), "Write a note{Enter}");
  const panel = within(await screen.findByRole("complementary", { name: "Artifact: Note" }));
  await user.click(panel.getByRole("button", { name: "Ask AI to edit" }));
  await user.type(panel.getByLabelText("What should change"), "Make it warmer{Enter}");

  expect(await panel.findByLabelText("Changes")).toHaveTextContent("−Hello world");
  expect(panel.getByLabelText("Changes")).toHaveTextContent("+Hello there, friend");
  expect(panel.getByText(/version 2/)).toBeInTheDocument();
  const asked = calls.anthropic?.[1]?.at(-1)?.content ?? "";
  expect(asked).toContain('Edit the artifact "Note" (id note): Make it warmer');
  // Costed like any answer.
  expect(screen.getAllByRole("button", { name: /Cost breakdown/ })).toHaveLength(2);
});

test("HTML and SVG artifacts preview live: HTML in a no-network sandbox, SVG as an image", async () => {
  const { previews, user } = setup({
    anthropic: [
      () =>
        answer(
          '<artifact id="page" type="html" title="Counter"><button onclick="n++">+</button></artifact>',
        ),
      () =>
        answer(
          '<artifact id="dot" type="svg" title="Dot"><svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg></artifact>',
        ),
    ],
  });
  await user.type(await composer(), "Make a counter page{Enter}");
  const panel = within(await screen.findByRole("complementary", { name: "Artifact: Counter" }));
  const frame = await panel.findByTitle("Preview of Counter");
  expect(frame).toHaveAttribute("src", "preview://localhost/p1");
  expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  expect(previews[0]).toMatch(/^<!doctype html>[\s\S]*<button onclick="n\+\+">\+<\/button>/);
  await user.click(panel.getByRole("tab", { name: "Code" }));
  expect(panel.getByText('<button onclick="n++">+</button>')).toBeInTheDocument();

  await user.type(await composer(), "Now an SVG dot{Enter}");
  const svg = within(await screen.findByRole("complementary", { name: "Artifact: Dot" }));
  expect(await svg.findByRole("img", { name: "Dot" })).toHaveAttribute(
    "src",
    expect.stringMatching(/^data:image\/svg\+xml/),
  );
});

test("React artifacts preview in the sandbox with React bundled; the CDN switch is per artifact", async () => {
  const { previews, previewCdn, user } = setup({
    anthropic: [
      () =>
        answer(
          '<artifact id="counter" type="react" title="Counter">import { useState } from "react";\nexport default function Counter() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{n}</button>; }</artifact>',
        ),
    ],
  });
  await user.type(await composer(), "Make a React counter{Enter}");
  const panel = within(await screen.findByRole("complementary", { name: "Artifact: Counter" }));
  const frame = await panel.findByTitle("Preview of Counter");
  expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  const page = previews.at(-1) ?? "";
  expect(page).toContain('<div id="root"></div>');
  expect(page).toContain("fuse.mount(module.exports)");
  // JSX is compiled before it reaches the frame.
  expect(page).not.toContain("<button onClick");
  expect(previewCdn.at(-1)).toBe(false);
  await user.click(panel.getByRole("checkbox", { name: "CDNs" }));
  await waitFor(() => {
    expect(previewCdn.at(-1)).toBe(true);
  });
  expect(panel.getByRole("checkbox", { name: "CDNs" })).toBeChecked();
});

test("export: an artifact saves as its own file, and Markdown also as .docx and .pdf", async () => {
  const { saves, user } = setup({
    anthropic: [
      () =>
        answer(
          '<artifact id="plan" type="markdown" title="Lisbon trip">\n# Day 1\nTram 28\n</artifact>',
        ),
    ],
  });
  await user.type(await composer(), "Plan it{Enter}");
  const panel = within(await screen.findByRole("complementary", { name: "Artifact: Lisbon trip" }));
  for (const item of ["Save as file…", "Save as Word (.docx)…", "Save as PDF…"]) {
    await user.click(panel.getByRole("button", { name: "Export artifact" }));
    await user.click(panel.getByRole("menuitem", { name: item }));
  }
  await waitFor(() => {
    expect(saves.map((x) => x.name)).toEqual([
      "Lisbon trip.md",
      "Lisbon trip.docx",
      "Lisbon trip.pdf",
    ]);
  });
  expect(new TextDecoder().decode(saves[0]?.bytes)).toBe("# Day 1\nTram 28");
  expect(saves[1]?.bytes.slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b])); // a zip
  expect(new TextDecoder().decode(saves[2]?.bytes.slice(0, 5))).toBe("%PDF-");
  expect(panel.getByRole("status")).toHaveTextContent("Saved Lisbon trip.pdf");
});

test("pins: next message only, then back to the chat's mode; a project can default to a tier", async () => {
  const { user } = setup({
    anthropic: [() => answer("From Best."), () => answer("From Balanced.")],
  });
  await composer();
  const modeButton = () => screen.getByRole("button", { name: "Choose model (Ctrl+K)" });
  await user.keyboard("{Control>}k{/Control}");
  await user.click(await screen.findByRole("checkbox", { name: "Next message only" }));
  await user.click(
    within(await screen.findByRole("group", { name: "Routing" })).getByRole("button", {
      name: /Best tier/,
    }),
  );
  expect(modeButton()).toHaveTextContent("Best· once");
  await user.type(await composer(), "Hard one{Enter}");
  expect(await screen.findByRole("button", { name: "Routing: Pinned · Best" })).toBeInTheDocument();
  expect(modeButton()).toHaveTextContent("Auto");
  await user.type(await composer(), "Easy one{Enter}");
  expect(
    await screen.findByRole("button", { name: "Routing: Auto · Balanced" }),
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "New project" }));
  const dialog = within(await screen.findByRole("dialog"));
  await user.type(dialog.getByLabelText("Name"), "Research");
  await user.selectOptions(dialog.getByLabelText("Default model"), "tier:best");
  await user.click(dialog.getByRole("button", { name: "Create project" }));
  await screen.findByRole("button", { name: "Project: Research" });
  expect(modeButton()).toHaveTextContent("Best");
});

test("command palette: Ctrl+Shift+P, type, Enter runs it; recent chats are there too", async () => {
  const { user } = setup({ anthropic: [() => answer("Ok.")] });
  await user.type(await composer(), "Plan the garden{Enter}");
  expect(await screen.findByText("Ok.")).toBeInTheDocument();
  await user.keyboard("{Control>}n{/Control}");

  await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  await user.type(await screen.findByLabelText("Type a command or a chat"), "garden");
  expect(screen.getByRole("option", { name: /Plan the garden/ })).toBeInTheDocument();
  await user.keyboard("{Enter}");
  expect(await screen.findByText("Ok.")).toBeInTheDocument();

  await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  await user.type(await screen.findByLabelText("Type a command or a chat"), "settings");
  expect(screen.getAllByRole("option")[0]).toHaveTextContent("Settings");
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("region", { name: "Budgets" })).toBeInTheDocument();
});

test("quick capture: the default shortcut is registered, pressing it opens a new chat, Settings changes it", async () => {
  const { quick, user } = setup({ anthropic: [() => answer("Ok.")] });
  await user.type(await composer(), "First{Enter}");
  expect(await screen.findByText("Ok.")).toBeInTheDocument();
  await waitFor(() => {
    expect(quick.registered).toEqual(["Ctrl+Alt+Space"]);
  });
  act(() => {
    quick.press();
  });
  expect(await screen.findByText("What are you working on?")).toBeInTheDocument();

  await user.keyboard("{Control>},{/Control}");
  const section = within(await screen.findByRole("region", { name: "Quick capture" }));
  expect(section.getByRole("status")).toHaveTextContent("On: Ctrl+Alt+Space");
  await user.clear(section.getByLabelText("Quick capture shortcut"));
  await user.type(section.getByLabelText("Quick capture shortcut"), "Super+J{Enter}");
  await waitFor(() => {
    expect(quick.registered.at(-1)).toBe("Super+J");
  });
  await user.click(
    within(screen.getByRole("region", { name: "Quick capture" })).getByRole("button", {
      name: "Turn off",
    }),
  );
  await waitFor(() => {
    expect(quick.registered.at(-1)).toBeNull();
  });
});

test("Settings → Your data exports everything as one zip", async () => {
  const { saves, user } = setup({ anthropic: [() => answer("Ok.")] });
  await user.type(await composer(), "Hello{Enter}");
  expect(await screen.findByText("Ok.")).toBeInTheDocument();
  await user.keyboard("{Control>},{/Control}");
  const data = within(await screen.findByRole("region", { name: "Your data" }));
  await user.click(data.getByRole("button", { name: /Export everything/ }));
  expect(await data.findByRole("status")).toHaveTextContent(
    /Saved fuse-export-\d{4}-\d{2}-\d{2}\.zip: 1 chats, 0 files\./,
  );
  expect(saves[0]?.bytes.slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
});

test("Settings → Your data backs up now, checks files and restores a backup after confirming", async () => {
  const { backups, user } = setup();
  backups.list.push({
    name: "fuse-1700000000000.db",
    createdMs: 1_700_000_000_000,
    bytes: 512 * 1024,
    reason: "update",
  });
  await composer();
  await user.keyboard("{Control>},{/Control}");
  const group = within(await screen.findByRole("group", { name: "Backups" }));
  expect(await group.findByText(/512 KB · before an update/)).toBeInTheDocument();

  await user.click(group.getByRole("button", { name: "Back up now" }));
  expect(await group.findByRole("status")).toHaveTextContent(
    /Backed up: .*2\.0 MB · backed up by you/,
  );
  expect(group.getAllByRole("button", { name: /^Restore / })).toHaveLength(2);

  await user.click(group.getByRole("button", { name: "Check attached files" }));
  expect(await group.findByRole("status")).toHaveTextContent(
    "Checked 3 attached files: 1 missing.",
  );

  await user.click(group.getByRole("button", { name: /^Restore .*before an update/ }));
  const dialog = within(await screen.findByRole("dialog"));
  await user.click(dialog.getByRole("button", { name: "Restore and restart" }));
  expect(backups.restored).toEqual(["fuse-1700000000000.db"]);
});

test("restore from an export: preview what's new, then bring it back (PL-12)", async () => {
  const { db, files, saves, user } = setup({ anthropic: [() => answer("Ok.")] });
  await user.type(await composer(), "Remember the boat{Enter}");
  expect(await screen.findByText("Ok.")).toBeInTheDocument();
  await user.keyboard("{Control>},{/Control}");
  const data = within(await screen.findByRole("region", { name: "Your data" }));
  await user.click(data.getByRole("button", { name: /Export everything/ }));
  await data.findByText(/Saved fuse-export/);
  await deleteAllData(db, DEFAULT_TENANT, files);

  const group = within(data.getByRole("group", { name: "Restore from an export" }));
  const bytes = saves[0]?.bytes ?? new Uint8Array();
  await user.upload(
    group.getByLabelText("Export file"),
    new File([new Uint8Array(bytes)], "fuse-export.zip", { type: "application/zip" }),
  );
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText(/An export of everything from/)).toBeInTheDocument();
  const holds = within(dialog.getByRole("list", { name: "What it holds" }));
  expect(await holds.findByText("Chats")).toBeInTheDocument();
  expect(holds.getByText("Chats").nextSibling).toHaveTextContent("1 new");
  await user.click(dialog.getByRole("button", { name: "Restore" }));
  expect(await group.findByRole("status")).toHaveTextContent(
    /^Restored \d+ records and 0 files\.$/,
  );
  await user.click(screen.getByRole("button", { name: "Back to conversation" }));
  expect(await sidebar().findByRole("button", { name: /^Remember the boat/ })).toBeInTheDocument();
});

test("delete everything: typed confirmation, all data gone, keys only when ticked, then a restart", async () => {
  const { db, keys, restarts, user } = setup({ anthropic: [() => answer("Ok.")] });
  await user.type(await composer(), "Hello{Enter}");
  expect(await screen.findByText("Ok.")).toBeInTheDocument();
  await user.keyboard("{Control>},{/Control}");
  const data = within(await screen.findByRole("region", { name: "Your data" }));
  await user.click(data.getByRole("button", { name: /Delete everything/ }));
  const dialog = within(await screen.findByRole("dialog"));
  const go = dialog.getByRole("button", { name: "Delete everything" });
  expect(go).toBeDisabled();
  await user.type(dialog.getByLabelText("Confirmation"), "delete everything");
  await user.click(dialog.getByRole("checkbox"));
  await user.click(go);
  await waitFor(() => {
    expect(restarts).toHaveLength(1);
  });
  const [messages] = await db.select<{ n: number }>("SELECT COUNT(*) AS n FROM messages");
  expect(messages?.n).toBe(0);
  expect(await listThreads(db, DEFAULT_TENANT)).toEqual([]);
  expect(keys.keys.size).toBe(0);
});

test("app lock: set a passcode, it locks on the next start, wrong ones are refused, the right one opens", async () => {
  const { db, user } = setup();
  await composer();
  await user.keyboard("{Control>},{/Control}");
  const section = within(await screen.findByRole("region", { name: "App lock" }));
  await user.type(section.getByLabelText("New passcode"), "4321");
  await user.type(section.getByLabelText("New passcode again"), "4321");
  await user.click(section.getByRole("button", { name: "Turn on app lock" }));
  expect(await section.findByText("App lock is on.")).toBeInTheDocument();
  const [row] = await db.select<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'lock.passcode_hash'",
  );
  expect(row?.value).toMatch(/^pbkdf2-sha256\$600000\$/);
  expect(row?.value).not.toContain("4321");

  // A fresh start of the app on the same database is locked.
  cleanup();
  render(
    <App
      openDb={() => Promise.resolve(db)}
      keysApi={fakeKeysApi().api}
      catalog={catalog}
      policy={policy}
    />,
  );
  const lockScreen = within(await screen.findByRole("main", { name: "FUSE is locked" }));
  expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
  await user.type(lockScreen.getByLabelText("Passcode"), "0000{Enter}");
  expect(await lockScreen.findByText("That passcode isn't right.")).toBeInTheDocument();
  await user.type(lockScreen.getByLabelText("Passcode"), "4321{Enter}");
  expect(await screen.findByRole("button", { name: "Choose model (Ctrl+K)" })).toBeInTheDocument();
}, 20_000);

test("app lock with Windows Hello: turned on in Settings, asked as soon as the lock screen shows", async () => {
  const { db, user, hello } = setup({}, undefined, {}, { helloAvailable: true });
  await composer();
  await user.keyboard("{Control>},{/Control}");
  const section = within(await screen.findByRole("region", { name: "App lock" }));
  expect(section.queryByRole("checkbox", { name: /Windows Hello/ })).not.toBeInTheDocument();
  await user.type(section.getByLabelText("New passcode"), "4321");
  await user.type(section.getByLabelText("New passcode again"), "4321");
  await user.click(section.getByRole("button", { name: "Turn on app lock" }));
  await user.click(await section.findByRole("checkbox", { name: /Unlock with Windows Hello/ }));

  cleanup();
  render(
    <App
      openDb={() => Promise.resolve(db)}
      keysApi={fakeKeysApi().api}
      catalog={catalog}
      policy={policy}
      hello={hello}
    />,
  );
  // Hello confirms it's you: the app opens without the passcode.
  expect(await screen.findByRole("button", { name: "Choose model (Ctrl+K)" })).toBeInTheDocument();
  expect(hello.asks).toEqual(["Unlock FUSE"]);
}, 20_000);

test("text size zooms the window and reduced motion stops animations; both are remembered", async () => {
  const { user, zooms } = setup();
  await composer();
  expect(zooms).toEqual([1]);
  await user.keyboard("{Control>},{/Control}");
  await user.click(
    within(await screen.findByRole("radiogroup", { name: "Text size" })).getByRole("radio", {
      name: "Large",
    }),
  );
  expect(zooms.at(-1)).toBe(1.15);
  expect(document.documentElement).not.toHaveClass("reduce-motion");
  await user.click(
    within(screen.getByRole("radiogroup", { name: "Motion" })).getByRole("radio", {
      name: "Reduced",
    }),
  );
  expect(document.documentElement).toHaveClass("reduce-motion");
  expect(localStorage.getItem("fuse.text_size")).toBe("large");
  expect(localStorage.getItem("fuse.motion")).toBe("reduce");
});

test("memory conflicts: a suggestion that contradicts a saved fact asks which stands; the old one stays as history", async () => {
  const { db } = setup();
  await composer();
  await addMemory(db, DEFAULT_TENANT, {
    text: "Lives in Leeds",
    kind: "fact",
    projectId: null,
    sourceThreadId: null,
    confidence: 100,
  });
  await addProposals(db, DEFAULT_TENANT, [
    {
      op: "add",
      memoryId: null,
      text: "Lives in York",
      kind: "fact",
      projectId: null,
      confidence: 90,
      sourceThreadId: null,
    },
  ]);
  cleanup();
  render(
    <App
      openDb={() => Promise.resolve(db)}
      keysApi={fakeKeysApi().api}
      catalog={catalog}
      policy={policy}
    />,
  );
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Choose model (Ctrl+K)" });
  await user.keyboard("{Control>},{/Control}");
  const section = within(await screen.findByRole("region", { name: "Memory" }));
  await user.click(await section.findByRole("button", { name: /Review/ }));
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText(/This may contradict what.s saved/)).toHaveTextContent("Lives in Leeds");
  // Keep all leaves it for a choice.
  await user.click(dialog.getByRole("button", { name: "Keep all" }));
  await user.click(await dialog.findByRole("button", { name: "Keep the new one" }));
  expect(await dialog.findByText("No suggestions waiting.")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(section.getByText("Lives in York")).toBeInTheDocument();
  });
  await user.click(section.getByText("Replaced facts (1)"));
  expect(section.getByRole("list", { name: "Replaced facts" })).toHaveTextContent(
    "Lives in Leeds → Lives in York",
  );
});

test("thread export: copy as Markdown, or save the chat as Markdown or JSON (every branch)", async () => {
  const { user, saves } = setup({ anthropic: [() => answer("Tea, mostly.")] });
  await user.type(await composer(), "Tea or coffee?{Enter}");
  await screen.findByText("Tea, mostly.");
  const menu = async (name: string) => {
    await user.click(screen.getByRole("button", { name: "Conversation actions" }));
    await user.click(await screen.findByRole("menuitem", { name }));
  };
  await menu("Copy as Markdown");
  await waitFor(async () => {
    expect(await navigator.clipboard.readText()).toMatch(
      /^# .+\n\n_Started \d{4}-\d{2}-\d{2}_\n\n## You\n\nTea or coffee\?\n\n## test-claude\n\nTea, mostly\./,
    );
  });
  await menu("Save as Markdown…");
  await menu("Save as JSON…");
  await waitFor(() => {
    expect(saves.map((f) => f.name.split(".").at(-1))).toEqual(["md", "json"]);
  });
  const json = JSON.parse(new TextDecoder().decode(saves[1]?.bytes)) as {
    format: string;
    messages: { role: string; content: string; model: string | null }[];
  };
  expect(json.format).toBe("fuse-chat");
  expect(json.messages.map((m) => [m.role, m.content])).toEqual([
    ["user", "Tea or coffee?"],
    ["assistant", "Tea, mostly."],
  ]);
});

test("quote a selection: select part of an answer, Reply to this puts just that in the reply", async () => {
  const { user } = setup({
    anthropic: [
      () => answer("The boiler needs a service in March. The warranty covers five years."),
    ],
  });
  await user.type(await composer(), "Boiler?{Enter}");
  const text = await screen.findByText(/The boiler needs a service/);
  const node = text.firstChild;
  if (!node?.textContent) throw new Error("no text node");
  const start = node.textContent.indexOf("The warranty");
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, node.textContent.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.mouseUp(text);
  await user.click(await screen.findByRole("button", { name: "Reply to this" }));
  expect(await composer()).toHaveValue("> The warranty covers five years.\n\n");
  expect(screen.queryByRole("button", { name: "Reply to this" })).not.toBeInTheDocument();
});

test("prompt library: saved in Settings, picked with / or the palette, variables filled first", async () => {
  const { user } = setup();
  await composer();
  await user.keyboard("{Control>},{/Control}");
  const section = within(await screen.findByRole("region", { name: "Prompt library" }));
  await user.type(section.getByLabelText("Prompt name"), "Summarize for someone");
  await user.click(section.getByLabelText("Prompt text"));
  await user.paste("Summarize this for {{audience}} in three bullets.");
  await user.click(section.getByRole("button", { name: "Add prompt" }));
  expect(
    await within(section.getByRole("list", { name: "Saved prompts" })).findByText(
      "Summarize for someone",
    ),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back to conversation" }));

  await user.type(await composer(), "/summ");
  expect(
    within(screen.getByRole("listbox", { name: "Saved prompts" })).getByRole("option", {
      name: "Summarize for someone",
    }),
  ).toBeInTheDocument();
  await user.keyboard("{Enter}");
  const dialog = within(await screen.findByRole("dialog", { name: "Summarize for someone" }));
  await user.type(dialog.getByLabelText("audience"), "my boss");
  await user.click(dialog.getByRole("button", { name: "Use prompt" }));
  await waitFor(async () => {
    expect(await composer()).toHaveValue("Summarize this for my boss in three bullets.");
  });

  // The palette lists it too.
  await user.clear(await composer());
  await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  expect(await screen.findByRole("option", { name: /Summarize for someone/ })).toBeInTheDocument();
});

test("compare mode: one question to two models, shown side by side; keep either one", async () => {
  const { user, calls } = setup({
    anthropic: [() => answer("Answer from Balanced."), () => answer("Answer from Best.")],
  });
  await composer();
  await user.click(screen.getByRole("button", { name: "Compare models" }));
  const pick = within(screen.getByRole("group", { name: "Models to compare" }));
  await user.click(pick.getByRole("checkbox", { name: "Test Claude · Balanced" }));
  await user.click(pick.getByRole("checkbox", { name: "Test Best · Best" }));
  await user.type(await composer(), "Which is better, tea or coffee?");
  expect(screen.getByLabelText("Compare cost")).toHaveTextContent(/Sends to 2 models · about \$/);
  await user.keyboard("{Enter}");

  const dialog = within(await screen.findByRole("dialog", { name: "Answers side by side" }));
  expect(dialog.getByRole("region", { name: "Answer from Test Claude" })).toHaveTextContent(
    "Answer from Balanced.",
  );
  expect(dialog.getByRole("region", { name: "Answer from Test Best" })).toHaveTextContent(
    "Answer from Best.",
  );
  // Both models got the same question.
  expect(calls.anthropic?.map((h) => h.at(-1)?.content)).toEqual([
    "Which is better, tea or coffee?",
    "Which is better, tea or coffee?",
  ]);
  await user.click(dialog.getByRole("checkbox", { name: "Show differences" }));
  expect(dialog.getByLabelText("Changes")).toHaveTextContent("Answer from Balanced.");
  await user.click(dialog.getByRole("checkbox", { name: "Show differences" }));
  // The newest answer is current; going on with the first switches the branch.
  await user.click(
    within(dialog.getByRole("region", { name: "Answer from Test Claude" })).getByRole("button", {
      name: "Go on with this one",
    }),
  );
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(await screen.findByText("Answer from Balanced.")).toBeInTheDocument();
  expect(screen.queryByText("Answer from Best.")).not.toBeInTheDocument();
  // Compare mode is used up by the send.
  expect(screen.getByRole("button", { name: "Compare models" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("learning from overrides: three moves up for one kind of question suggest a rule to test and save", async () => {
  const { db, user } = setup({ anthropic: [() => answer("Everyday answer.")] });
  await user.type(await composer(), "What is FUSE?{Enter}");
  await user.click(await screen.findByRole("button", { name: "Try a stronger model (Best)" }));
  await screen.findByRole("button", { name: "Routing: Stronger · Best" });
  const noted = await getSetting(db, DEFAULT_TENANT, "routing.overrides");
  expect(JSON.parse(noted ?? "[]")).toMatchObject([
    { intent: "chat", complexity: "low", from: "balanced", to: "best" },
  ]);
  // Two more like it, then a fresh start.
  const more = JSON.parse(noted ?? "[]") as unknown[];
  await setSetting(
    db,
    DEFAULT_TENANT,
    "routing.overrides",
    JSON.stringify([...more, ...more, ...more]),
  );
  cleanup();
  render(
    <App
      openDb={() => Promise.resolve(db)}
      keysApi={fakeKeysApi().api}
      catalog={catalog}
      policy={policy}
    />,
  );
  const notice = await screen.findByLabelText("Routing suggestion");
  expect(notice).toHaveTextContent("Chat questions (low) start on Best");
  await user.click(within(notice).getByRole("button", { name: "See it" }));
  const editor = within(await screen.findByRole("region", { name: "Routing policy" }));
  await user.click(
    within(editor.getByLabelText("Suggested rules")).getByRole("button", { name: "Add to rules" }),
  );
  expect(
    editor.getByRole("listitem", { name: "You often moved chat questions up to Best" }),
  ).toBeInTheDocument();
  await user.click(editor.getByRole("button", { name: "Test on the routing test set" }));
  await user.click(editor.getByRole("button", { name: "Save" }));
  expect(await getSetting(db, DEFAULT_TENANT, "routing.policy")).toContain("learned-chat-best");
  expect(screen.queryByLabelText("Routing suggestion")).not.toBeInTheDocument();
}, 20_000);

test("stay on this provider: offered once a chat has an answer, saved on the chat", async () => {
  const { user, db } = setup();
  await user.type(await composer(), "Hello{Enter}");
  await screen.findByRole("button", { name: "Cost breakdown for Test Claude" });
  await user.click(screen.getByRole("button", { name: "Conversation actions" }));
  await user.click(await screen.findByRole("menuitemcheckbox", { name: "Stay on Anthropic" }));
  await waitFor(async () => {
    const [row] = await db.select<{ stay_provider: string | null }>(
      "SELECT stay_provider FROM threads",
    );
    expect(row?.stay_provider).toBe("anthropic");
  });
  await user.click(screen.getByRole("button", { name: "Conversation actions" }));
  expect(
    await screen.findByRole("menuitemcheckbox", { name: "Stay on Anthropic" }),
  ).toHaveAttribute("aria-checked", "true");
});

test("an unsure question gets the Cheap tier's second opinion, which can move it to Best", async () => {
  const question =
    "Can you write up a plan comparing two options for our team offsite, and draft the email?";
  const { user, choreCalls, db } = setup({}, undefined, {
    classify: ['{"intent": "reasoning", "complexity": "high"}'],
  });
  await user.type(await composer(), `${question}{Enter}`);
  expect(
    await screen.findByRole("button", { name: "Cost breakdown for Test Best" }),
  ).toBeInTheDocument();
  expect(choreCalls.filter((c) => c.kind === "classify")).toEqual([
    { kind: "classify", model: "test-gpt", input: question },
  ]);
  const logged = await listRecentRequests(db, DEFAULT_TENANT, 10);
  expect(logged.some((r) => r.purpose === "classify" && r.model === "test-gpt")).toBe(true);
  const [answerRow] = await db.select<{ route_reason: string }>(
    "SELECT route_reason FROM messages WHERE role = 'assistant'",
  );
  expect(answerRow?.route_reason).toMatch(/\(checked by Test GPT\)$/);
});

test("routing policy: a new rule is tested, saved, and Auto follows it", async () => {
  const { user, db } = setup();
  await composer();
  await user.keyboard("{Control>},{/Control}");
  const section = within(await screen.findByRole("region", { name: "Routing policy" }));
  await user.click(section.getByRole("button", { name: "Add rule" }));
  const rule = within(section.getByRole("listitem", { name: "New rule" }));
  expect(rule.getByRole("button", { name: "Writing" })).toHaveAttribute("aria-pressed", "true");
  expect(rule.getByLabelText("Start on")).toHaveValue("best");
  const save = section.getByRole("button", { name: "Save" });
  expect(save).toBeDisabled();
  await user.click(section.getByRole("button", { name: "Test on the routing test set" }));
  expect(section.getByText(/No routing test set to score against/)).toBeInTheDocument();
  await user.click(save);
  expect(await section.findByText("Saved.")).toBeInTheDocument();
  expect(await getSetting(db, DEFAULT_TENANT, "routing.policy")).toContain('"New rule"');

  await user.click(screen.getByRole("button", { name: "Back to conversation" }));
  await user.type(await composer(), "Write an email to my landlord about the boiler{Enter}");
  expect(
    await screen.findByRole("button", { name: "Cost breakdown for Test Best" }),
  ).toBeInTheDocument();
});

test("models: a tier model the provider stopped listing is flagged; a new one can be added with prices", async () => {
  const { user, remote } = setup();
  remote.anthropic = [
    { id: "test-best", displayName: "Test Best" },
    { id: "test-claude-2", displayName: "Test Claude 2" },
  ];
  remote.openai = [{ id: "test-gpt", displayName: "Test GPT" }];
  const notice = await screen.findByLabelText("Models notice");
  expect(notice).toHaveTextContent("no longer listed by its provider: Test Claude.");
  await user.click(within(notice).getByRole("button", { name: "See models" }));
  const section = within(await screen.findByRole("region", { name: "Models" }));
  expect(section.getByRole("list", { name: "Models no longer listed" })).toHaveTextContent(
    "Test Claude is no longer listed by Anthropic (used by Balanced). Its newest replacement is test-claude-2.",
  );
  await user.click(
    within(section.getByLabelText("New models")).getByRole("button", { name: "Add…" }),
  );
  const form = within(section.getByRole("form", { name: "Add a model" }));
  expect(form.getByLabelText("Model id")).toHaveValue("test-claude-2");
  await user.type(form.getByLabelText("Input $ per 1M tokens"), "3");
  await user.type(form.getByLabelText("Output $ per 1M tokens"), "15");
  await user.click(form.getByRole("button", { name: "Add model" }));
  expect(
    within(section.getByRole("list", { name: "Models you added" })).getByText("Test Claude 2"),
  ).toBeInTheDocument();
  const prices = within(screen.getByRole("region", { name: "Prices" }));
  expect(prices.getByText("Test Claude 2").closest("tr")).toHaveTextContent("Test Claude 2$3$15");
});

test("prices: edit one model's price, then check the repo for a newer list and use it", async () => {
  const { user, web } = setup();
  await composer();
  await user.keyboard("{Control>},{/Control}");
  const section = within(await screen.findByRole("region", { name: "Prices" }));
  await user.click(section.getByRole("button", { name: "Edit Test Claude price" }));
  const input = section.getByLabelText("Test Claude input price");
  await user.clear(input);
  await user.type(input, "4");
  await user.click(section.getByRole("button", { name: "Save" }));
  expect(await section.findByText("(yours)")).toBeInTheDocument();
  const row = (name: string) => section.getByText(name, { exact: false }).closest("tr");
  expect(row("Test Claude")).toHaveTextContent("Test Claude(yours)$4$10");

  const model = (id: string, name: string, provider: string, input: number) => ({
    provider,
    id,
    display_name: name,
    context_window: 200000,
    max_output: 1000,
    price: { input, output: input * 4 },
    capabilities: ["vision", "web_search"],
    verified_on: "2026-11-01",
    source_url: "https://example.com",
  });
  web.fetch = (url: string) => {
    web.reads.push(url);
    return Promise.resolve({
      url,
      contentType: "text/plain",
      body: JSON.stringify({
        price_version: "2026-11-01",
        models: [
          model("test-claude", "Test Claude", "anthropic", 2),
          model("test-gpt", "Test GPT", "openai", 0.5),
          model("test-best", "Test Best", "anthropic", 10),
        ],
      }),
      truncated: false,
    });
  };
  await user.click(section.getByRole("button", { name: "Check for new prices" }));
  const changes = within(await section.findByLabelText("New prices"));
  expect(changes.getByText(/input \$1 → \$0\.5, output \$4 → \$2/)).toBeInTheDocument();
  expect(web.reads.at(-1)).toMatch(/raw\.githubusercontent\.com\/.*\/data\/models\.json$/);
  await user.click(changes.getByRole("button", { name: "Use these prices" }));
  expect(await section.findByText("Now using price list 2026-11-01.")).toBeInTheDocument();
  expect(row("Test GPT")).toHaveTextContent("Test GPT$0.5$2");
  // Your own edit stays.
  expect(section.getByText("(yours)")).toBeInTheDocument();
});

test("chats can be pinned to the top, archived out of the list, and tagged and filtered", async () => {
  const { user } = setup();
  const gardenTitle = "Plan the vegetable garden";
  await user.type(await composer(), `${gardenTitle}{Enter}`);
  await sidebar().findByText(gardenTitle);
  await user.click(screen.getByRole("button", { name: /^New chat/ }));
  await user.type(await composer(), "Draft the quarterly report{Enter}");
  await sidebar().findByText("Draft the quarterly report");

  await user.click(screen.getByRole("button", { name: "Conversation actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Tags…" }));
  await user.type(within(await screen.findByRole("dialog")).getByLabelText("Tags"), "work");
  await user.click(screen.getByRole("button", { name: "Save tags" }));
  const filter = within(await screen.findByRole("group", { name: "Filter by tag" }));
  await user.click(filter.getByRole("button", { name: "#work" }));
  await waitFor(() => {
    expect(sidebar().queryByText(gardenTitle)).not.toBeInTheDocument();
  });
  await user.click(filter.getByRole("button", { name: "#work" }));

  await user.click(await sidebar().findByRole("button", { name: `Pin ${gardenTitle}` }));
  const pinned = within(await sidebar().findByRole("region", { name: "Pinned" }));
  expect(pinned.getByText(gardenTitle)).toBeInTheDocument();
  await user.click(pinned.getByRole("button", { name: `Archive ${gardenTitle}` }));
  await waitFor(() => {
    expect(sidebar().queryByRole("region", { name: "Pinned" })).not.toBeInTheDocument();
  });
  const archived = within(sidebar().getByRole("region", { name: "Archived" }));
  await user.click(archived.getByRole("button", { name: "Archived (1)" }));
  await user.click(archived.getByRole("button", { name: `Unarchive ${gardenTitle}` }));
  await waitFor(() => {
    expect(sidebar().queryByRole("region", { name: "Archived" })).not.toBeInTheDocument();
  });
});

test("import from ChatGPT: preview first, then the chats appear in the sidebar", async () => {
  const { user } = setup();
  await composer();
  const zip = zipSync({
    "conversations.json": strToU8(
      JSON.stringify([
        {
          conversation_id: "c1",
          title: "Old garden chat",
          create_time: 1_700_000_000,
          current_node: "a",
          mapping: {
            q: {
              id: "q",
              parent: null,
              message: {
                author: { role: "user" },
                create_time: 1_700_000_001,
                content: { content_type: "text", parts: ["Tomatoes?"] },
              },
            },
            a: {
              id: "a",
              parent: "q",
              message: {
                author: { role: "assistant" },
                create_time: 1_700_000_002,
                content: { content_type: "text", parts: ["Yes."] },
              },
            },
          },
        },
      ]),
    ),
  });
  await user.keyboard("{Control>},{/Control}");
  const section = within(await screen.findByRole("region", { name: "Import" }));
  await user.click(section.getByRole("button", { name: "From ChatGPT…" }));
  await user.upload(section.getByLabelText("Export file"), new File([zip], "export.zip"));
  const preview = within(await section.findByLabelText("Import preview"));
  expect(preview.getByText(/1 chats \(2 messages\) from ChatGPT\./)).toBeInTheDocument();
  await user.click(preview.getByRole("button", { name: "Import 1 chats" }));
  expect(await section.findByText("Imported 1 chats.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Back to conversation/ }));
  await user.click(await sidebar().findByText("Old garden chat"));
  expect(await screen.findByText("Tomatoes?")).toBeInTheDocument();
  expect(screen.getByText("Yes.")).toBeInTheDocument();
});

test("pasted memories become suggestions to review; pasted instructions fill a global box after a confirm", async () => {
  const { user } = setup();
  await composer();
  await user.keyboard("{Control>},{/Control}");
  const section = within(await screen.findByRole("region", { name: "Import" }));
  await user.type(
    section.getByLabelText("Pasted text"),
    "## Saved memories{enter}- Prefers short answers{enter}- Lives in Leeds{enter}- lives in leeds",
  );
  await user.click(section.getByRole("button", { name: "Suggest these memories" }));
  const review = within(await screen.findByRole("dialog"));
  const suggested = await review.findAllByLabelText("Suggested memory");
  expect(suggested.map((s) => (s as HTMLTextAreaElement).value)).toEqual([
    "Prefers short answers",
    "Lives in Leeds",
  ]);
  await user.keyboard("{Escape}");
  expect(await section.findByText("2 memories to review (1 already known).")).toBeInTheDocument();

  await user.click(section.getByRole("radio", { name: "How to answer" }));
  await user.type(section.getByLabelText("Pasted text"), "Be brief.");
  await user.click(section.getByRole("button", { name: /Use as "How to answer"/ }));
  expect(section.getByRole("alert")).toHaveTextContent('This fills "How to answer"');
  await user.click(section.getByRole("button", { name: "Add to How to answer" }));
  expect(await section.findByText(/Added to "How to answer"/)).toBeInTheDocument();
  const instructions = within(screen.getByRole("region", { name: "Custom instructions" }));
  expect(instructions.getByLabelText("How to answer")).toHaveValue("Be brief.");
});

test("import from Claude: chats land in their project, which gets its instructions and documents", async () => {
  const { db, user } = setup();
  await composer();
  const zip = zipSync({
    "conversations.json": strToU8(
      JSON.stringify([
        {
          uuid: "c1",
          name: "Lisbon days",
          created_at: "2026-05-01T10:00:00Z",
          project_uuid: "p1",
          chat_messages: [
            {
              uuid: "m1",
              sender: "human",
              text: "Plan Lisbon",
              created_at: "2026-05-01T10:00:00Z",
            },
            {
              uuid: "m2",
              sender: "assistant",
              text: "Day 1: Alfama.",
              created_at: "2026-05-01T10:01:00Z",
            },
          ],
        },
      ]),
    ),
    "projects.json": strToU8(
      JSON.stringify([
        {
          uuid: "p1",
          name: "Travel",
          prompt_template: "Prices in euros.",
          docs: [{ filename: "notes.md", content: "Hotel near Rossio." }],
        },
      ]),
    ),
  });
  await user.keyboard("{Control>},{/Control}");
  const section = within(await screen.findByRole("region", { name: "Import" }));
  await user.click(section.getByRole("button", { name: "From Claude…" }));
  await user.upload(section.getByLabelText("Export file"), new File([zip], "claude.zip"));
  const preview = within(await section.findByLabelText("Import preview"));
  expect(preview.getByText(/1 projects with their instructions and documents/)).toBeInTheDocument();
  await user.click(preview.getByRole("button", { name: "Import 1 chats" }));
  expect(await section.findByText("Imported 1 chats.")).toBeInTheDocument();

  const [project] = await db.select<{ id: string; name: string; instructions: string }>(
    "SELECT id, name, instructions FROM projects",
  );
  expect(project).toMatchObject({ name: "Travel", instructions: "Prices in euros." });
  const [thread] = await listThreads(db, DEFAULT_TENANT);
  expect(thread).toMatchObject({ title: "Lisbon days", projectId: project?.id });
  const docs = await db.select<{ name: string }>(
    "SELECT f.name FROM project_files pf JOIN files f ON f.id = pf.file_id",
  );
  expect(docs.map((d) => d.name)).toEqual(["notes.md"]);
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
  expect(options[0]).toEqual({
    scope: { kind: "thread", id: expect.any(String) as string },
    webSearch: true,
    system: ARTIFACT_GUIDE,
  });

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
    // No keys here, so the composer asks for one: wait for the app itself.
    await screen.findByRole("button", { name: "Choose model (Ctrl+K)" });
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
    expect(options[0]).toEqual({
      scope: { kind: "thread", id: expect.any(String) as string },
      webSearch: true,
      system: ARTIFACT_GUIDE,
    }); // just the app guide
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
        { op: "add", text: "Lives in York.", kind: "fact", confidence: 90 },
        { op: "add", text: "Bike lock PIN is 4821", kind: "fact" },
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

  test("Settings lists memories by kind; secrets are refused; edit and delete", async () => {
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
    await user.selectOptions(section.getAllByLabelText("Kind")[0] as HTMLElement, "preference");
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

  test("exclude a memory without deleting it; each answer records why each memory went (PM-17)", async () => {
    const { db, options, user } = setup();
    await composer();
    await user.keyboard("{Control>},{/Control}");
    const section = within(await screen.findByRole("region", { name: "Memory" }));
    for (const text of ["Lives in Leeds.", "Prefers short answers."]) {
      await user.type(section.getByLabelText("New memory"), text);
      await user.click(section.getByRole("button", { name: "Add memory" }));
      expect(await section.findByText(text)).toBeInTheDocument();
    }
    await user.click(
      section.getByRole("button", { name: "Exclude memory: Prefers short answers." }),
    );
    await waitFor(() => {
      expect(section.queryByText("Prefers short answers.")).not.toBeInTheDocument();
    });
    await user.selectOptions(section.getByLabelText("Show status"), "not_in_use");
    expect(await section.findByText(/added by you · .* · excluded/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to conversation" }));

    await user.type(await composer(), "Hi{Enter}");
    expect(await screen.findByRole("button", { name: "1 memory used" })).toBeInTheDocument();
    const system = (options.at(-1) as { system?: string }).system ?? "";
    expect(system).toContain("- Lives in Leeds.");
    expect(system).not.toContain("short answers");
    const rows = await db.select<{ reason: string }>("SELECT reason FROM message_memories");
    expect(rows).toEqual([{ reason: "all_fit" }]);

    // Still there, and back in use when included again.
    await user.keyboard("{Control>},{/Control}");
    const again = within(await screen.findByRole("region", { name: "Memory" }));
    await user.selectOptions(again.getByLabelText("Show status"), "not_in_use");
    await user.click(
      await again.findByRole("button", { name: "Include memory again: Prefers short answers." }),
    );
    await user.selectOptions(again.getByLabelText("Show status"), "in_use");
    expect(await again.findByText("Prefers short answers.")).toBeInTheDocument();
  });

  test("a memory kept for one chat, sensitive and on this device: shown with its provenance, never sent (PM-12 to PM-14)", async () => {
    const { options, user } = setup();
    await user.type(await composer(), "Plan the garden{Enter}");
    expect(await screen.findByText("Hello there.")).toBeInTheDocument();
    await user.keyboard("{Control>},{/Control}");
    const section = within(await screen.findByRole("region", { name: "Memory" }));
    await user.type(section.getByLabelText("New memory"), "Shed code is under the pot.");
    await user.selectOptions(
      section.getByLabelText("Used in"),
      section.getByRole("option", { name: /Only in the chat/ }),
    );
    await user.click(section.getByLabelText("Sensitive"));
    await user.click(section.getByLabelText(/Keep on this device/));
    await user.click(section.getByRole("button", { name: "Add memory" }));
    const facts = within(await section.findByRole("list", { name: "About you" }));
    expect(
      facts.getByText(/only in “.*” · added by you · .*sensitive · kept on this device/),
    ).toBeInTheDocument();
    expect(facts.getByText("Sent to models").nextSibling).toHaveTextContent("never");

    await user.type(section.getByLabelText("New memory"), "Lives in Leeds.");
    fireEvent.change(section.getByLabelText("Expires on"), { target: { value: "2020-01-01" } });
    await user.click(section.getByRole("button", { name: "Add memory" }));
    // Already expired, so not listed as in use.
    await waitFor(() => {
      expect(section.getByLabelText("New memory")).toHaveValue("");
    });
    expect(section.queryByText("Lives in Leeds.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to conversation" }));
    await user.type(await composer(), "Where is the shed code?{Enter}");
    await waitFor(() => {
      expect(options).toHaveLength(2);
    });
    const system = (options.at(-1) as { system?: string }).system ?? "";
    expect(system).not.toContain("Shed code");
    expect(system).not.toContain("Leeds");

    await user.keyboard("{Control>},{/Control}");
    const again = within(await screen.findByRole("region", { name: "Memory" }));
    await user.selectOptions(again.getByLabelText("Show status"), "not_in_use");
    expect(await again.findByText("Lives in Leeds.")).toBeInTheDocument();
    expect(again.queryByText("Shed code is under the pot.")).not.toBeInTheDocument();
    expect(again.getByText(/added by you · .* · expired/)).toBeInTheDocument();
    await user.selectOptions(again.getByLabelText("Show status"), "all");
    await user.selectOptions(again.getByLabelText("Show where used"), "chat");
    expect(again.getByText("Shed code is under the pot.")).toBeInTheDocument();
    expect(again.queryByText("Lives in Leeds.")).not.toBeInTheDocument();
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

  test("decisions: added and replaced in project settings, sent first in the project's chats (PM-15)", async () => {
    const { options, user } = setup();
    await composer();
    await user.click(screen.getByRole("button", { name: "New project" }));
    const create = within(await screen.findByRole("dialog"));
    await user.type(create.getByLabelText("Name"), "Kitchen");
    await user.click(create.getByRole("button", { name: "Create project" }));
    await user.click(await screen.findByRole("button", { name: "Project: Kitchen" }));
    const dialog = within(await screen.findByRole("dialog"));
    const section = within(dialog.getByRole("region", { name: "Decisions" }));
    expect(section.getByText("No decisions yet.")).toBeInTheDocument();

    await user.click(section.getByRole("button", { name: "Add decision" }));
    await user.type(section.getByLabelText("Decision"), "Laminate worktops.");
    // Enter in a decision doesn't save and close the project.
    await user.type(section.getByLabelText("Decision"), "{Enter}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.type(section.getByLabelText("Why"), "Cheapest.");
    await user.click(section.getByRole("button", { name: "Add decision" }));
    expect(await section.findByText("Laminate worktops.")).toBeInTheDocument();

    await user.click(section.getByRole("button", { name: "Replace decision: Laminate worktops." }));
    expect(
      section.getByText("Laminate worktops.", { selector: ".line-through" }),
    ).toBeInTheDocument();
    await user.type(section.getByLabelText("Decision"), "Oak worktops.");
    await user.type(section.getByLabelText("Why"), "They last longer.");
    await user.type(section.getByLabelText("Ruled out"), "Laminate{Enter}Granite");
    await user.click(section.getByRole("button", { name: "Add decision" }));
    const inForce = within(await section.findByRole("list", { name: "Decisions in force" }));
    expect(inForce.getByText("Oak worktops.")).toBeInTheDocument();
    expect(inForce.getByText("Ruled out: Laminate; Granite")).toBeInTheDocument();
    expect(inForce.queryByText("Laminate worktops.")).not.toBeInTheDocument();
    expect(
      within(section.getByRole("list", { name: "Replaced decisions" })).getByText(
        "→ Oak worktops.",
        { exact: false },
      ),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.type(await composer(), "Which worktop?{Enter}");
    expect(await screen.findByText("Hello there.")).toBeInTheDocument();
    const system = (options.at(-1) as { system?: string }).system ?? "";
    expect(system).toContain(
      "- Decision: Oak worktops. Reason: They last longer. Ruled out: Laminate; Granite",
    );
    expect(system).not.toContain("Laminate worktops.");
  });

  test("tasks: added, chained and finished in project settings; open ones reach the model (PM-16)", async () => {
    const { options, user } = setup();
    await composer();
    await user.click(screen.getByRole("button", { name: "New project" }));
    const create = within(await screen.findByRole("dialog"));
    await user.type(create.getByLabelText("Name"), "Kitchen");
    await user.click(create.getByRole("button", { name: "Create project" }));
    await user.click(await screen.findByRole("button", { name: "Project: Kitchen" }));
    const dialog = within(await screen.findByRole("dialog"));
    const section = within(dialog.getByRole("region", { name: "Tasks" }));
    await user.type(section.getByLabelText("New task"), "Order oak samples{Enter}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.type(section.getByLabelText("New task"), "Fit the worktop");
    await user.click(section.getByRole("button", { name: "Add task" }));
    const open = within(await section.findByRole("list", { name: "Open tasks" }));
    expect(await open.findByText("Fit the worktop")).toBeInTheDocument();

    await user.click(open.getByRole("button", { name: "Edit task: Fit the worktop" }));
    await user.click(section.getByRole("checkbox", { name: "Order oak samples" }));
    await user.click(section.getByRole("button", { name: "Save task" }));
    expect(await open.findByText("Blocked by Order oak samples")).toBeInTheDocument();

    await user.selectOptions(open.getByLabelText("Status of Order oak samples"), "done");
    await waitFor(() => {
      expect(open.queryByText("Blocked by Order oak samples")).not.toBeInTheDocument();
    });
    expect(
      within(section.getByRole("list", { name: "Finished tasks" })).getByText("Order oak samples"),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.type(await composer(), "What's next?{Enter}");
    expect(await screen.findByText("Hello there.")).toBeInTheDocument();
    const system = (options.at(-1) as { system?: string }).system ?? "";
    expect(system).toContain("- Task (to do): Fit the worktop");
    expect(system).not.toContain("Order oak samples");
  });

  test("project privacy: a blocked provider gets nothing; Local only sends nothing; both say why (SE-13)", async () => {
    const { calls, user } = setup();
    await composer();
    await user.click(screen.getByRole("button", { name: "New project" }));
    const create = within(await screen.findByRole("dialog"));
    await user.type(create.getByLabelText("Name"), "Health");
    await user.click(create.getByRole("button", { name: "Create project" }));
    const openPrivacy = async () => {
      await user.click(await screen.findByRole("button", { name: "Project: Health" }));
      return within(
        within(await screen.findByRole("dialog")).getByRole("region", { name: "Project privacy" }),
      );
    };
    const privacy = await openPrivacy();
    await user.selectOptions(privacy.getByLabelText("Anthropic in this project"), "block");
    await waitFor(() => {
      expect(privacy.getByLabelText("Anthropic in this project")).toHaveValue("block");
    });
    await user.keyboard("{Escape}");

    // Balanced is Anthropic-only in the test catalog, so nothing may answer at the floor.
    await user.type(await composer(), "My blood results?{Enter}");
    expect(
      await screen.findByText(
        /The project “Health” blocks Anthropic; allow it in privacy settings/,
      ),
    ).toBeInTheDocument();
    expect(calls.anthropic).toHaveLength(0);

    const again = await openPrivacy();
    await user.selectOptions(again.getByLabelText("Anthropic in this project"), "default");
    await user.selectOptions(again.getByLabelText("Privacy mode"), "local_only");
    expect(await again.findByText(/no local model yet/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.type(await composer(), "And now?{Enter}");
    expect(await screen.findByText(/set to Local only, so nothing is sent/)).toBeInTheDocument();
    expect(calls.anthropic).toHaveLength(0);
    expect(calls.openai).toHaveLength(0);
  });

  test("Settings → Privacy says what's sent where, and a provider blocked everywhere is blocked in projects too (SE-15)", async () => {
    const { user } = setup();
    await composer();
    await user.keyboard("{Control>},{/Control}");
    const privacy = within(await screen.findByRole("region", { name: "Privacy" }));
    expect(privacy.getByText(/Stored locally doesn.t mean answered locally/)).toBeInTheDocument();
    expect(privacy.getByText(/What a cloud answer sends/)).toBeInTheDocument();
    await user.selectOptions(privacy.getByLabelText("OpenAI everywhere"), "block");
    await waitFor(() => {
      expect(privacy.getByLabelText("OpenAI everywhere")).toHaveValue("block");
    });
    await user.click(screen.getByRole("button", { name: "Back to conversation" }));

    await user.click(screen.getByRole("button", { name: "New project" }));
    const create = within(await screen.findByRole("dialog"));
    await user.type(create.getByLabelText("Name"), "Garden");
    await user.click(create.getByRole("button", { name: "Create project" }));
    await user.click(await screen.findByRole("button", { name: "Project: Garden" }));
    const project = within(
      within(await screen.findByRole("dialog")).getByRole("region", { name: "Project privacy" }),
    );
    expect(project.getByRole("option", { name: "As everywhere (blocked)" })).toBeInTheDocument();
  });

  test("a project exports on its own as a FUSE export (PL-12)", async () => {
    const { saves, user } = setup();
    await composer();
    await user.click(screen.getByRole("button", { name: "New project" }));
    const create = within(await screen.findByRole("dialog"));
    await user.type(create.getByLabelText("Name"), "Kitchen / 2026");
    await user.click(create.getByRole("button", { name: "Create project" }));
    await user.type(await composer(), "Oak or laminate?{Enter}");
    expect(await screen.findByText("Hello there.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Project: Kitchen / 2026" }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Export project…" }));
    expect(await dialog.findByRole("status")).toHaveTextContent(
      /Saved fuse-project-Kitchen - 2026-\d{4}-\d{2}-\d{2}\.zip: 1 chats, 0 files\./,
    );
    const zip = unzipSync(saves[0]?.bytes ?? new Uint8Array());
    expect(JSON.parse(strFromU8(zip["manifest.json"] ?? new Uint8Array()))).toMatchObject({
      version: 2,
      scope: { kind: "project", name: "Kitchen / 2026" },
    });
  });

  test("project knowledge: files are indexed once and searched for every chat in the project", async () => {
    const { calls, user } = setup({ anthropic: [() => answer("At dawn.")] });
    await composer();
    await user.click(screen.getByRole("button", { name: "New project" }));
    const create = within(await screen.findByRole("dialog"));
    await user.type(create.getByLabelText("Name"), "Sailing");
    await user.click(create.getByRole("button", { name: "Create project" }));
    await user.click(await screen.findByRole("button", { name: "Project: Sailing" }));
    const dialog = within(await screen.findByRole("dialog"));
    const knowledge = within(dialog.getByRole("region", { name: "Knowledge files" }));
    const notes = [
      ...Array.from({ length: 50 }, (_, i) => `Apple note ${String(i)}: apple apple.`),
      "The boat leaves at dawn from the boat harbour.",
      ...Array.from({ length: 50 }, (_, i) => `Cloud note ${String(i)}: cloud cloud.`),
    ].join("\n");
    await user.upload(
      knowledge.getByLabelText("Add knowledge files"),
      new File([notes], "logbook.md", { type: "text/markdown" }),
    );
    expect(await knowledge.findByText("Searchable")).toBeInTheDocument();
    expect(knowledge.getByText(/a message if sent whole/)).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.type(await composer(), "When does the boat leave?{Enter}");
    expect(await screen.findByText("At dawn.")).toBeInTheDocument();
    const sent = calls.anthropic?.[0]?.[0];
    const excerpts = sent?.attachments?.find((a) => a.kind === "text");
    expect(excerpts && "text" in excerpts ? excerpts.text : "").toContain(
      "The boat leaves at dawn",
    );
    expect(
      within(await screen.findByLabelText("From your files and chats")).getAllByText(/logbook\.md/)
        .length,
    ).toBeGreaterThan(0);
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

test("M6: a linked project's chat runs a coding task: steps, cost and the answer", async () => {
  const repo: RepoApi = {
    ...noRepo,
    pick: () => Promise.resolve({ root: "/home/me/lighthouse", name: "lighthouse", isGit: true }),
    read: (_p, path) =>
      path === "README.md"
        ? Promise.resolve({
            path,
            content: "# Lighthouse\n",
            offset: 0,
            totalBytes: 13,
            truncated: false,
          })
        : Promise.reject(new Error(`${path}: no such file or folder.`)),
  };
  async function* lookFirst(_h: ChatMessage[]): AsyncGenerator<StreamEvent> {
    await Promise.resolve();
    yield { type: "text", text: "1. Read the README." };
    yield {
      type: "tool_call",
      call: { id: "c1", name: "read_file", input: { path: "README.md", offset: null } },
    };
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
      stopReason: "tool_use",
      providerRequestId: "req_t",
      attempts: 1,
      turn: { provider: "anthropic", model: "x", items: [] },
    };
  }
  const { user, calls } = setup(
    { anthropic: [lookFirst, () => answer("It's called Lighthouse.")] },
    undefined,
    {},
    { repo },
  );
  await user.click(await screen.findByRole("button", { name: "New project" }));
  const create = within(await screen.findByRole("dialog"));
  await user.type(create.getByLabelText("Name"), "Lighthouse");
  await user.click(create.getByRole("button", { name: "Create project" }));
  await screen.findByRole("button", { name: "Project: Lighthouse" });
  // No folder yet: no Code toggle.
  expect(screen.queryByRole("button", { name: "Coding run" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Lighthouse settings" }));
  const settings = within(await screen.findByRole("dialog"));
  await user.click(settings.getByRole("button", { name: "Link a folder…" }));
  expect(await settings.findByText("/home/me/lighthouse")).toBeInTheDocument();
  expect(settings.getByText("lighthouse: a git repository.")).toBeInTheDocument();
  await user.keyboard("{Escape}");

  await user.click(await screen.findByRole("button", { name: "Coding run" }));
  await user.type(await composer(), "What is this project called?{Enter}");
  const card = within(await screen.findByRole("region", { name: "Coding run" }));
  expect(await card.findByText("Done")).toBeInTheDocument();
  expect(card.getByText("Read README.md")).toBeInTheDocument();
  expect(card.getByText("1. Read the README.")).toBeInTheDocument();
  expect(await screen.findByText("It's called Lighthouse.")).toBeInTheDocument();
  // The tool result went back to the model with the turn.
  expect(calls.anthropic?.at(-1)?.at(-1)?.toolResults?.[0]?.content).toBe("# Lighthouse\n");
});

test("M6: a run that can edit shows each change as a diff, and Undo puts the file back", async () => {
  const files = new Map([["src/tide.ts", "export const tide = 3;\n"]]);
  const repo: RepoApi = {
    ...noRepo,
    pick: () => Promise.resolve({ root: "/home/me/lighthouse", name: "lighthouse", isGit: true }),
    read: (_p, path) => {
      const content = files.get(path);
      return content === undefined
        ? Promise.reject(new Error(`${path}: no such file or folder.`))
        : Promise.resolve({
            path,
            content,
            offset: 0,
            totalBytes: content.length,
            truncated: false,
          });
    },
    write: (_p, path, content) => {
      const before = files.get(path) ?? null;
      files.set(path, content);
      return Promise.resolve({ path, before });
    },
  };
  async function* edit(_h: ChatMessage[]): AsyncGenerator<StreamEvent> {
    await Promise.resolve();
    yield { type: "text", text: "1. Change the tide." };
    yield {
      type: "tool_call",
      call: {
        id: "e1",
        name: "edit_file",
        input: { path: "src/tide.ts", old_text: "= 3", new_text: "= 4" },
      },
    };
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
      stopReason: "tool_use",
      providerRequestId: "req_e",
      attempts: 1,
      turn: { provider: "anthropic", model: "x", items: [] },
    };
  }
  const { user, options } = setup(
    { anthropic: [edit, () => answer("Changed the tide to 4.")] },
    undefined,
    {},
    { repo },
  );
  await user.click(await screen.findByRole("button", { name: "New project" }));
  const create = within(await screen.findByRole("dialog"));
  await user.type(create.getByLabelText("Name"), "Lighthouse");
  await user.click(create.getByRole("button", { name: "Create project" }));
  await user.click(await screen.findByRole("button", { name: "Lighthouse settings" }));
  const settings = within(await screen.findByRole("dialog"));
  await user.click(settings.getByRole("button", { name: "Link a folder…" }));
  await settings.findByText("/home/me/lighthouse");
  await user.keyboard("{Escape}");

  await user.click(await screen.findByRole("button", { name: "Coding run" }));
  await user.selectOptions(screen.getByLabelText("What the coding run may do"), "auto_edit");
  await user.type(await composer(), "Make the tide 4{Enter}");
  expect(await screen.findByText("Changed the tide to 4.")).toBeInTheDocument();
  const card = within(screen.getByRole("region", { name: "Coding run" }));
  expect(card.getByText("can edit files")).toBeInTheDocument();
  expect(files.get("src/tide.ts")).toBe("export const tide = 4;\n");
  // The edit tools went with the request.
  const sentTools = (options.at(-1) as { tools?: { name: string }[] }).tools?.map((x) => x.name);
  expect(sentTools).toContain("edit_file");

  await user.click(card.getByRole("button", { name: "Edited src/tide.ts" }));
  expect(card.getByText("export const tide = 4;")).toBeInTheDocument();
  await user.click(card.getByRole("button", { name: "Undo" }));
  expect(await card.findByText("Undone")).toBeInTheDocument();
  expect(files.get("src/tide.ts")).toBe("export const tide = 3;\n");
});
