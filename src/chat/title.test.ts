// @vitest-environment node
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import type { ProviderAdapter, StreamEvent } from "@/providers/types";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { addMessage, finishMessage, type Message } from "@/storage/messages";
import { listRecentRequests } from "@/storage/requestLog";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread, getThread, renameThread } from "@/storage/threads";
import { EMPTY_USAGE } from "@/storage/usage";
import { autoTitle, cleanTitle, MAX_TITLE_CHARS, wantsAutoTitle } from "./title";

const t = DEFAULT_TENANT;
// Placeholder prices for arithmetic; real ones live in data/models.json.
const catalog = parseCatalog({
  price_version: "2026-10-26",
  models: [
    {
      provider: "openai",
      id: "small",
      display_name: "Small",
      context_window: 200000,
      max_output: 1000,
      price: { input: 0.1, output: 0.5 },
      capabilities: [],
      verified_on: "2026-10-26",
      source_url: "https://example.com",
    },
  ],
});
const small = catalog.models[0] as CatalogModel;

function adapter(reply: string | Error, onCall?: () => Promise<void>): ProviderAdapter {
  return {
    provider: "openai",
    listModels: () => Promise.resolve([]),
    async *streamChat(): AsyncGenerator<StreamEvent> {
      await onCall?.();
      if (reply instanceof Error) throw reply;
      yield { type: "text", text: reply };
      yield {
        type: "done",
        usage: { ...EMPTY_USAGE, inputTokens: 300, outputTokens: 10 },
        usageReported: true,
        stopReason: "stop",
        providerRequestId: null,
        attempts: 1,
      };
    },
  };
}

async function firstExchange(db: ReturnType<typeof openTestDb>) {
  const thread = await createThread(db, t);
  await renameThread(db, t, thread.id, "plan a trip to lisbon…", "auto");
  const q = await addMessage(db, t, {
    threadId: thread.id,
    parentId: null,
    role: "user",
    content: "plan a trip to lisbon with the kids",
  });
  const a = await addMessage(db, t, {
    threadId: thread.id,
    parentId: q,
    role: "assistant",
    content: "",
    status: "streaming",
  });
  await finishMessage(db, t, a, {
    content: "Here's a 4-day plan.",
    status: "complete",
    usage: EMPTY_USAGE,
    errorCode: null,
    errorMessage: null,
    requestId: null,
  });
  return thread;
}

test.each([
  ['"Lisbon trip with kids."', "Lisbon trip with kids"],
  ["Title: Lisbon trip with kids", "Lisbon trip with kids"],
  ["## **Lisbon trip**\n\nMore text", "Lisbon trip"],
  ["   \n  ", null],
])("cleanTitle(%j) → %j", (reply, title) => {
  expect(cleanTitle(reply)).toBe(title);
});

test("cleanTitle caps the length", () => {
  const title = cleanTitle("word ".repeat(40)) ?? "";
  expect(title.length).toBe(MAX_TITLE_CHARS);
  expect(title.endsWith("…")).toBe(true);
});

test("wantsAutoTitle: only right after the first complete answer of an auto-titled chat", () => {
  const m = (role: Message["role"], status: Message["status"]) => ({ role, status }) as Message;
  const first = [m("user", "complete"), m("assistant", "complete")];
  expect(wantsAutoTitle("auto", first)).toBe(true);
  expect(wantsAutoTitle("user", first)).toBe(false);
  expect(wantsAutoTitle("auto", [m("user", "complete"), m("assistant", "error")])).toBe(false);
  expect(wantsAutoTitle("auto", [...first, m("user", "complete"), m("assistant", "error")])).toBe(
    false,
  );
  expect(
    wantsAutoTitle("auto", [...first, m("user", "complete"), m("assistant", "complete")]),
  ).toBe(false);
});

test("autoTitle renames the chat and logs a title request", async () => {
  const db = openTestDb();
  const thread = await firstExchange(db);
  const r = await autoTitle(
    { db, tenant: t, adapterFor: () => adapter("Lisbon trip with kids") },
    catalog,
    thread.id,
    small,
  );
  expect(r).toEqual({ title: "Lisbon trip with kids" });
  expect(await getThread(db, t, thread.id)).toMatchObject({
    title: "Lisbon trip with kids",
    titleSource: "auto",
  });
  const [log] = await listRecentRequests(db, t, 1);
  expect(log).toMatchObject({ purpose: "title", model: "small", threadId: thread.id });
  // 300 × $0.10/MTok + 10 × $0.50/MTok = $0.000035
  expect(log?.usage.costMicroUsd).toBe(35);
});

test("a rename by hand while the model thinks wins", async () => {
  const db = openTestDb();
  const thread = await firstExchange(db);
  const r = await autoTitle(
    {
      db,
      tenant: t,
      adapterFor: () =>
        adapter("Lisbon trip with kids", () => renameThread(db, t, thread.id, "Our May trip")),
    },
    catalog,
    thread.id,
    small,
  );
  expect(r.title).toBeNull();
  expect((await getThread(db, t, thread.id))?.title).toBe("Our May trip");
});

test("a failed call keeps the first-line title and reports the error", async () => {
  const db = openTestDb();
  const thread = await firstExchange(db);
  const r = await autoTitle(
    { db, tenant: t, adapterFor: () => adapter(new Error("network down")) },
    catalog,
    thread.id,
    small,
  );
  expect(r.title).toBeNull();
  expect(r.error).toBeTruthy();
  expect((await getThread(db, t, thread.id))?.title).toBe("plan a trip to lisbon…");
});
