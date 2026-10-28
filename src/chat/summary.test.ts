// @vitest-environment node
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import type { ChatMessage, ChatOptions, StreamEvent } from "@/providers/types";
import { DEFAULT_TENANT } from "@/storage/defaults";
import type { Message } from "@/storage/messages";
import { listRecentRequests } from "@/storage/requestLog";
import { listSummaries } from "@/storage/summaries";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread } from "@/storage/threads";
import { EMPTY_USAGE } from "@/storage/usage";
import { sendMessage, type ChatDeps } from "./sendMessage";
import { keptMessages, maybeSummarize, SUMMARY_SYSTEM, summaryThreshold } from "./summary";

const t = DEFAULT_TENANT;
const catalog = parseCatalog({
  price_version: "2026-10-28",
  models: [
    {
      provider: "anthropic",
      id: "big",
      display_name: "Big",
      context_window: 1_000_000,
      max_output: 1000,
      price: { input: 1, output: 5 },
      capabilities: [],
      verified_on: "2026-10-28",
      source_url: "https://example.com",
    },
    {
      provider: "openai",
      id: "cliff",
      display_name: "Cliff",
      context_window: 1_000_000,
      max_output: 1000,
      price: { input: 1, output: 5 },
      long_context_price: { above_input_tokens: 272_000, input: 2, output: 7.5 },
      capabilities: [],
      verified_on: "2026-10-28",
      source_url: "https://example.com",
    },
  ],
});
const big = catalog.models[0] as CatalogModel;
const cliff = catalog.models[1] as CatalogModel;

test("summarizing starts at 3/4 of the window, or just under a long-context price jump", () => {
  expect(summaryThreshold(big)).toBe(750_000);
  expect(summaryThreshold(cliff)).toBe(244_800);
});

test("turns with files and everything after the summary are kept in full", () => {
  const m = (id: string, role: "user" | "assistant") => ({ id, role }) as Message;
  const path = [
    m("q1", "user"),
    m("a1", "assistant"),
    m("q2", "user"),
    m("a2", "assistant"),
    m("q3", "user"),
  ];
  expect(keptMessages(path, 3, new Set(["q2"])).map((x) => x.id)).toEqual(["q2", "a2", "q3"]);
  expect(keptMessages(path, 1, new Set()).map((x) => x.id)).toEqual(["q2", "a2", "q3"]);
});

test("a thread past the threshold is summarized; later turns send the summary and recent turns", async () => {
  const db = openTestDb();
  const calls: { system: string | undefined; history: ChatMessage[] }[] = [];
  let n = 0;
  const reply = (text: string, input: number): AsyncGenerator<StreamEvent> =>
    (async function* () {
      await Promise.resolve();
      yield { type: "text", text };
      yield {
        type: "done",
        usage: { ...EMPTY_USAGE, inputTokens: input, outputTokens: 10, webSearchCalls: 0 },
        usageReported: true,
        stopReason: "end_turn",
        providerRequestId: null,
        attempts: 1,
      };
    })();
  const deps: ChatDeps = {
    db,
    tenant: t,
    catalog,
    adapterFor: (provider) => ({
      provider,
      listModels: () => Promise.resolve([]),
      streamChat(history: ChatMessage[], _model: string, opts: ChatOptions) {
        if (opts.system === SUMMARY_SYSTEM) return reply("They planned a trip to Lisbon.", 500);
        calls.push({ system: opts.system, history });
        n += 1;
        // The fifth answer reports a huge context, pushing the thread past the threshold.
        return reply(`answer ${String(n)}`, n === 5 ? 800_000 : 100);
      },
    }),
  };
  const thread = await createThread(db, t);
  for (let i = 1; i <= 5; i++) {
    await sendMessage(deps, { threadId: thread.id, model: big, text: `question ${String(i)}` });
  }
  expect(await maybeSummarize(deps, catalog, thread.id, cliff, summaryThreshold(big))).toEqual({
    summarized: true,
  });
  const [summary] = await listSummaries(db, t, thread.id);
  expect(summary?.summary).toBe("They planned a trip to Lisbon.");
  expect((await listRecentRequests(db, t, 1))[0]?.purpose).toBe("summary");

  await sendMessage(deps, { threadId: thread.id, model: big, text: "question 6" });
  const last = calls.at(-1);
  expect(last?.system).toContain("<earlier_conversation>");
  expect(last?.system).toContain("They planned a trip to Lisbon.");
  // Questions 1-2 are summarized; the latest three exchanges (KEEP_RECENT) and the new one stay.
  expect(last?.history.map((h) => h.content)).toEqual([
    "question 3",
    "answer 3",
    "question 4",
    "answer 4",
    "question 5",
    "answer 5",
    "question 6",
  ]);
  // Below the threshold nothing happens.
  expect(await maybeSummarize(deps, catalog, thread.id, cliff, 10_000_000)).toEqual({
    summarized: false,
  });
});
