// M9 step 2, part 2: fetch_url in plain chat. A model that takes tools may read pages in a few
// rounds; each round is logged and priced, and the answer costs them all. Runs in jsdom (the
// default), since the page reader parses HTML with the DOM, as the app's webview does.
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import { unavailableLocalAdapter } from "@/providers/local/adapter";
import type {
  ChatMessage,
  ChatOptions,
  ProviderAdapter,
  StreamEvent,
  ToolCall,
} from "@/providers/types";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { citationsForMessages } from "@/storage/citations";
import { listMessages } from "@/storage/messages";
import { createProject, setProjectPrivacy } from "@/storage/projects";
import { switchProjectTool } from "@/storage/projectTools";
import { listRecentRequests } from "@/storage/requestLog";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread, setThreadProject } from "@/storage/threads";
import type { WebApi } from "@/web/api";
import { MAX_CHAT_TOOL_ROUNDS, sendMessage, type ChatDeps } from "./sendMessage";

const t = DEFAULT_TENANT;
// Placeholder prices: $2 in and $10 out per MTok.
const catalog = parseCatalog({
  price_version: "2026-10-31",
  models: [
    {
      provider: "anthropic",
      id: "test-claude",
      display_name: "Test Claude",
      context_window: 200000,
      max_output: 1000,
      price: { input: 2, output: 10 },
      capabilities: ["tools"],
      verified_on: "2026-10-31",
      source_url: "https://example.com",
    },
    {
      provider: "anthropic",
      id: "test-plain",
      display_name: "Test Plain",
      context_window: 200000,
      max_output: 1000,
      price: { input: 2, output: 10 },
      capabilities: [],
      verified_on: "2026-10-31",
      source_url: "https://example.com",
    },
  ],
});
const claude = catalog.models[0] as CatalogModel;
const plain = catalog.models[1] as CatalogModel;

const PAGE =
  "<html><head><title>Tides</title></head><body><main><h1>Tides</h1><p>High tide is at 6.</p></main></body></html>";

/** Each turn: some text, then tool calls (none = the final answer). 1,000 in and 100 out each. */
function scripted(turns: { text: string; calls?: ToolCall[] }[]) {
  const histories: ChatMessage[][] = [];
  const options: ChatOptions[] = [];
  let n = 0;
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(history, model, opts): AsyncGenerator<StreamEvent> {
      histories.push(history);
      options.push(opts);
      const turn = turns[n++] ?? { text: "Done." };
      await Promise.resolve();
      yield { type: "text", text: turn.text };
      for (const call of turn.calls ?? []) yield { type: "tool_call", call };
      yield {
        type: "done",
        usage: {
          inputTokens: 1000,
          outputTokens: 100,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: true,
        stopReason: turn.calls?.length ? "tool_use" : "end_turn",
        providerRequestId: `req_${String(n)}`,
        attempts: 1,
        ...(turn.calls?.length
          ? { turn: { provider: "anthropic" as const, model, items: [{ round: n }] } }
          : {}),
      };
    },
  };
  return { adapter, histories, options };
}

const fetchCall = (url: string, id = "f1"): ToolCall => ({ id, name: "fetch_url", input: { url } });

function setup(adapter: ProviderAdapter, web?: WebApi) {
  const db = openTestDb();
  const deps: ChatDeps = {
    db,
    tenant: t,
    catalog,
    adapterFor: (p) => (p === "local" ? unavailableLocalAdapter() : adapter),
    cache: false,
    ...(web ? { web } : {}),
  };
  return { db, deps };
}

const pageWeb = (asked: string[] = []): WebApi => ({
  fetch: (url) => {
    asked.push(url);
    return Promise.resolve({
      url: "https://docs.example.com/tides",
      contentType: "text/html",
      body: PAGE,
      truncated: false,
    });
  },
});

test("a chat answer reads a page, then answers from it; each round is logged, the answer costs both", async () => {
  const asked: string[] = [];
  const { adapter, histories, options } = scripted([
    { text: "Let me read it.", calls: [fetchCall("https://docs.example.com/tides")] },
    { text: "High tide is at 6." },
  ]);
  const { db, deps } = setup(adapter, pageWeb(asked));
  const thread = await createThread(db, t);
  // 1,000 × $2/MTok + 100 × $10/MTok = $0.003 a round.
  const r = await sendMessage(deps, {
    threadId: thread.id,
    model: claude,
    text: "When is high tide?",
  });
  expect(r).toMatchObject({ status: "complete", costMicroUsd: 6_000 });
  expect(asked).toEqual(["https://docs.example.com/tides"]);

  expect(options[0]?.tools?.map((x) => x.name)).toEqual(["fetch_url"]);
  // The second request replays the tool turn and carries the page.
  const replay = histories[1]?.slice(-2);
  expect(replay?.[0]).toMatchObject({
    role: "assistant",
    content: "Let me read it.",
    native: { provider: "anthropic", model: "test-claude", items: [{ round: 1 }] },
  });
  expect(replay?.[1]?.toolResults?.[0]).toMatchObject({ callId: "f1", isError: false });
  expect(replay?.[1]?.toolResults?.[0]?.content).toContain("High tide is at 6.");

  const [, answer] = await listMessages(db, t, thread.id);
  expect(answer).toMatchObject({
    content: "Let me read it.\n\nHigh tide is at 6.",
    status: "complete",
    usage: { inputTokens: 2000, outputTokens: 200, costMicroUsd: 6_000 },
  });
  const rows = (await listRecentRequests(db, t, 10)).filter((x) => x.purpose === "chat");
  expect(rows.map((x) => x.usage.costMicroUsd)).toEqual([3_000, 3_000]);
  expect(rows.every((x) => x.messageId === answer?.id)).toBe(true);
  // The page read is the answer's source.
  const cited = (await citationsForMessages(db, t, [answer?.id ?? ""])).get(answer?.id ?? "");
  expect(cited?.map((c) => c.url)).toEqual(["https://docs.example.com/tides"]);
});

test("after a few tool rounds the model must answer without tools", async () => {
  const many = Array.from({ length: MAX_CHAT_TOOL_ROUNDS + 1 }, (_, i) => ({
    text: `Reading ${String(i + 1)}.`,
    calls: [fetchCall(`https://example.com/${String(i)}`, `f${String(i)}`)],
  }));
  const { adapter, options } = scripted([...many, { text: "Here's what I found." }]);
  const { db, deps } = setup(adapter, pageWeb());
  const thread = await createThread(db, t);
  await sendMessage(deps, { threadId: thread.id, model: claude, text: "Read a lot" });
  expect(options).toHaveLength(MAX_CHAT_TOOL_ROUNDS + 1);
  expect(options.at(-1)?.tools).toBeUndefined();
});

test("no tools for a model that doesn't take them, without a reader, in Local only, or switched off", async () => {
  const offered = async (
    model: CatalogModel,
    web: WebApi | undefined,
    prep?: (db: ChatDeps["db"], threadId: string) => Promise<void>,
  ) => {
    const { adapter, options } = scripted([{ text: "Hi." }]);
    const { db, deps } = setup(adapter, web);
    const thread = await createThread(db, t);
    await prep?.(db, thread.id);
    await sendMessage(deps, { threadId: thread.id, model, text: "Hello" });
    return options[0]?.tools;
  };
  expect(await offered(plain, pageWeb())).toBeUndefined();
  expect(await offered(claude, undefined)).toBeUndefined();
  expect(
    await offered(claude, pageWeb(), async (db, threadId) => {
      const p = await createProject(db, t, "Lighthouse");
      await setThreadProject(db, t, threadId, p.id);
      await switchProjectTool(db, t, p.id, "fetch_url", false);
    }),
  ).toBeUndefined();
  // Local only: the cloud model is refused before anything is sent.
  const { adapter, options } = scripted([{ text: "Hi." }]);
  const { db, deps } = setup(adapter, pageWeb());
  const thread = await createThread(db, t);
  const p = await createProject(db, t, "Private");
  await setProjectPrivacy(db, t, p.id, { mode: "local_only", allowEmbeddings: false });
  await setThreadProject(db, t, thread.id, p.id);
  expect(
    (await sendMessage(deps, { threadId: thread.id, model: claude, text: "Hello" })).status,
  ).toBe("error");
  expect(options).toHaveLength(0);
});
