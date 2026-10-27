// The real app (storage, keys, chat engine) on an in-memory SQLite DB, with scripted providers.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseCatalog } from "@/catalog/catalog";
import { memoryFilesApi } from "@/files/api";
import type { PreparedImage } from "@/files/images";
import { ProviderError } from "@/providers/errors";
import type { ChatMessage, ProviderAdapter, StreamEvent } from "@/providers/types";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { listRecentRequests } from "@/storage/requestLog";
import { openTestDb } from "@/storage/testing/nodeDb";
import { listThreads } from "@/storage/threads";
import { fakeKeysApi } from "@/test/fakeKeysApi";
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

function setup(
  scripts: Partial<Record<"anthropic" | "openai", Script[]>> = {},
  savedKeys: ("anthropic" | "openai")[] = ["anthropic", "openai"],
) {
  const db = openTestDb();
  const keys = fakeKeysApi();
  for (const p of savedKeys) keys.keys.set(p, "fake-value-for-tests-0000");
  const calls: Record<string, ChatMessage[][]> = { anthropic: [], openai: [] };
  const options_: unknown[] = [];
  const adapterFor = (provider: "anthropic" | "openai"): ProviderAdapter => ({
    provider,
    listModels: () => Promise.resolve([]),
    streamChat(history, _model, options, signal) {
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
      files={files}
      prepareImage={fakePrepare}
    />,
  );
  return { db, keys, calls, options: options_, files, user: userEvent.setup() };
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
  expect((await listRecentRequests(db, DEFAULT_TENANT, 10))[0]).toMatchObject({
    purpose: "chat",
    model: "test-claude",
  });
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
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("401 · Invalid bearer token");
  expect(rows[1]).toHaveTextContent("Test Claude");
  expect(rows[1]).toHaveTextContent("1,200 / 400");
  expect(rows[1]).toHaveTextContent("$0.0064");
  expect(rows[1]).toHaveTextContent("OK");
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
  render(<App openDb={() => Promise.resolve(db)} keysApi={keys.api} catalog={catalog} />);
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
  const props = { openDb: () => Promise.resolve(db), keysApi: keys.api, catalog };
  const adapterFor = () =>
    ({
      provider: "anthropic",
      listModels: () => Promise.resolve([]),
      streamChat: () => answer("Remember me."),
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

test("a model without vision can't be sent an image", async () => {
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
      files={memoryFilesApi()}
      prepareImage={fakePrepare}
    />,
  );
  const user = userEvent.setup();
  await composer();
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

test("web search: toggle per thread, live status, cited sources and the search fee", async () => {
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
    expect(options[0]).toEqual({});
    await user.click(screen.getByRole("button", { name: "Instructions (none)" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("None set.")).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Edit in Settings" }));
    expect(await screen.findByRole("region", { name: "Custom instructions" })).toBeInTheDocument();
  });
});
