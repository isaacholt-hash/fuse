// @vitest-environment node
// M7 step 11 (LL-06, RT-13): the exact-match cache. Same first question, same context, same
// model, same project: the stored answer at $0. Anything else asks the model.
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { findModel, type CatalogModel } from "@/catalog/catalog";
import { messageViews } from "@/app/viewModels";
import { regenerate, sendMessage, type ChatDeps } from "@/chat/sendMessage";
import { scriptedLocal } from "@/providers/local/scripted";
import { checkClassification } from "@/routing/classifyFallback";
import { classify } from "@/routing/classify";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { listPath } from "@/storage/messages";
import { createProject } from "@/storage/projects";
import { listRecentRequests } from "@/storage/requestLog";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread, setThreadInstructions } from "@/storage/threads";
import { cloudCallsAvoidedSince } from "@/storage/usageReport";
import { cacheClear, cacheGet, cacheKey, cachePut, chatCacheable, TTL_MS } from "./responseCache";

const t = DEFAULT_TENANT;
const sonnet = findModel(defaultCatalog, "anthropic", "claude-sonnet-5-5") as CatalogModel;
const haiku = findModel(defaultCatalog, "anthropic", "claude-haiku-5-5") as CatalogModel;

const ok = {
  question: "Explain the difference between TCP and UDP.",
  firstInChat: true,
  files: 0,
  webSearch: false,
  incognito: false,
  memoriesSent: 0,
};

test("only a plain first question: nothing attached, no search, not incognito, nothing stale or personal", () => {
  expect(chatCacheable(ok)).toBe(true);
  expect(chatCacheable({ ...ok, firstInChat: false })).toBe(false);
  expect(chatCacheable({ ...ok, files: 1 })).toBe(false);
  expect(chatCacheable({ ...ok, webSearch: true })).toBe(false);
  expect(chatCacheable({ ...ok, incognito: true })).toBe(false);
  expect(chatCacheable({ ...ok, memoriesSent: 2 })).toBe(false);
  for (const q of [
    "What's the weather today?",
    "Latest news on the election",
    "What is the price of bitcoin",
    "What happened in 2026?",
    "What should I name my cat?",
    "What dose of ibuprofen is safe?",
    "Is this contract clause legal?",
  ]) {
    expect(chatCacheable({ ...ok, question: q }), q).toBe(false);
  }
});

test("stored entries: found by key and scope, gone when expired, never across projects", async () => {
  const db = openTestDb();
  const key = await cacheKey(["chat", "m", "q"]);
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(await cacheKey(["chat", "m", "q "])).not.toBe(key);
  await cachePut(
    db,
    t,
    { key, kind: "chat", scope: "p1", model: "anthropic/x", response: "A", costMicroUsd: 500 },
    1000,
  );
  expect(await cacheGet(db, t, key, "p1", 2000)).toMatchObject({
    response: "A",
    costMicroUsd: 500,
  });
  expect(await cacheGet(db, t, key, "p2", 2000)).toBeNull();
  expect(await cacheGet(db, t, key, "p1", 1000 + TTL_MS.chat)).toBeNull();
  // Expired entries are removed on the way.
  await cachePut(
    db,
    t,
    { key, kind: "chat", scope: "p1", model: "anthropic/x", response: "B", costMicroUsd: 1 },
    5000,
  );
  await cacheClear(db, t);
  expect(await cacheGet(db, t, key, "p1", 6000)).toBeNull();
});

function setup(replies: string[]) {
  const db = openTestDb();
  const cloud = scriptedLocal(replies, "fallback answer");
  const deps: ChatDeps = {
    db,
    tenant: t,
    catalog: defaultCatalog,
    adapterFor: () => cloud.adapter,
  };
  return { db, deps, cloud };
}

const ask = async (deps: ChatDeps, threadId: string, text: string) =>
  sendMessage(deps, { threadId, model: sonnet, text });

test("the same first question in a new chat is answered from the cache at $0; regenerate asks again", async () => {
  const { db, deps, cloud } = setup(["TCP is reliable; UDP is fast.", "Fresh answer."]);
  const a = await createThread(db, t);
  await ask(deps, a.id, ok.question);
  const b = await createThread(db, t);
  const r = await ask(deps, b.id, ok.question);
  expect(r).toMatchObject({ status: "complete", costMicroUsd: 0 });
  expect(cloud.calls).toHaveLength(1);
  const { path } = await listPath(db, t, b.id);
  expect(path[1]).toMatchObject({ content: "TCP is reliable; UDP is fast.", provider: "cache" });
  expect(messageViews(path, defaultCatalog)[1]).toMatchObject({ cachedFrom: "Claude Sonnet 5.5" });
  expect((await listRecentRequests(db, t))[0]).toMatchObject({
    provider: "cache",
    purpose: "chat",
  });
  expect(await cloudCallsAvoidedSince(db, t, 0)).toBe(1);
  // Regenerate never uses the cache.
  await regenerate(deps, { threadId: b.id, model: sonnet, answerId: path[1]?.id ?? "" });
  expect(cloud.calls).toHaveLength(2);
});

test("misses: another project, other instructions, a follow-up, incognito", async () => {
  const { db, deps, cloud } = setup([]);
  const first = await createThread(db, t);
  await ask(deps, first.id, ok.question);
  expect(cloud.calls).toHaveLength(1);
  // Another project: its own scope.
  const project = await createProject(db, t, "Work");
  await ask(deps, (await createThread(db, t, "x", project.id)).id, ok.question);
  expect(cloud.calls).toHaveLength(2);
  // Same question, different instructions: a different context.
  const withRules = await createThread(db, t);
  await setThreadInstructions(db, t, withRules.id, "Answer in French.");
  await ask(deps, withRules.id, ok.question);
  expect(cloud.calls).toHaveLength(3);
  // A follow-up is never cached or served.
  await ask(deps, first.id, ok.question);
  expect(cloud.calls).toHaveLength(4);
  // Incognito: neither read nor written.
  const secret = await createThread(db, t, "x", null, true);
  await ask(deps, secret.id, ok.question);
  expect(cloud.calls).toHaveLength(5);
});

test("the classifier's second opinion is reused for the same words", async () => {
  const { db, deps, cloud } = setup(['{"intent": "coding", "complexity": "high"}']);
  const thread = await createThread(db, t);
  const question = "refactor this whole module, maybe?";
  const local = { ...classify({ text: question }), unsure: true };
  const first = await checkClassification(deps, defaultCatalog, haiku, local, question, thread.id);
  const again = await checkClassification(deps, defaultCatalog, haiku, local, question, thread.id);
  expect(first).toMatchObject({ intent: "coding", complexity: "high" });
  expect(again).toMatchObject({ intent: "coding", complexity: "high" });
  expect(cloud.calls).toHaveLength(1);
});
