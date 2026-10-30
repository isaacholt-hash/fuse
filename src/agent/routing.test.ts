// @vitest-environment node
// M6 step 11: routing inside runs (CA-07, RT-14). A Best model plans in a request of its own; the
// loop stays on the routed model; summaries are on the Cheap tier (compaction.test.ts).
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import { ProviderError } from "@/providers/errors";
import type { ChatMessage, ChatOptions, ProviderAdapter, StreamEvent } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, setProjectRepo } from "@/storage/projects";
import { listRecentRequests } from "@/storage/requestLog";
import { getRun } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { startRun, type RunDeps } from "./run";

const t = DEFAULT_TENANT;
const catalog = parseCatalog({
  price_version: "2026-10-30",
  models: [
    {
      provider: "anthropic",
      id: "balanced",
      display_name: "Balanced",
      context_window: 200000,
      max_output: 1000,
      price: { input: 1, output: 1 },
      capabilities: [],
      verified_on: "2026-10-30",
      source_url: "https://example.com",
    },
    {
      provider: "anthropic",
      id: "best",
      display_name: "Best",
      context_window: 200000,
      max_output: 8000,
      price: { input: 10, output: 10 },
      capabilities: [],
      verified_on: "2026-10-30",
      source_url: "https://example.com",
    },
  ],
});
const balanced = catalog.models[0] as CatalogModel;
const best = catalog.models[1] as CatalogModel;
const repo: RepoApi = {
  pick: () => Promise.resolve(null),
  check: () => Promise.reject(new Error("unused")),
  list: () => Promise.resolve([]),
  search: () => Promise.resolve([]),
  read: () => Promise.reject(new Error("no such file")),
  write: () => Promise.reject(new Error("unused")),
  remove: () => Promise.reject(new Error("unused")),
  move: () => Promise.reject(new Error("unused")),
};

async function setup(planner: CatalogModel | null, planFails = false) {
  const db = openTestDb();
  const project = await createProject(db, t, "Lighthouse");
  await setProjectRepo(db, t, project.id, { root: "/repo", readSecrets: false });
  const sent: { model: string; history: ChatMessage[]; options: ChatOptions }[] = [];
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(history, model, options): AsyncGenerator<StreamEvent> {
      sent.push({ model, history: structuredClone(history), options: structuredClone(options) });
      await Promise.resolve();
      if (model === "best" && planFails)
        throw new ProviderError("overloaded", "busy", { status: 529 });
      yield {
        type: "text",
        text: model === "best" ? "1. Find tide.ts.\n2. Check the rounding." : "Done.",
      };
      yield {
        type: "done",
        usage: {
          inputTokens: 100_000,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: true,
        stopReason: "end_turn",
        providerRequestId: null,
        attempts: 1,
        ...(options.tools ? { turn: { provider: "anthropic" as const, model, items: [] } } : {}),
      };
    },
  };
  const deps: RunDeps = { db, tenant: t, catalog, adapterFor: () => adapter, repo };
  const run = await startRun(deps, {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: "Fix the tide rounding",
    model: balanced,
    planner,
    capMicroUsd: 5_000_000,
  });
  return { db, sent, run };
}

test("Auto: Best plans first without tools, then the routed model works with that plan", async () => {
  const { db, sent, run } = await setup(best);
  expect(sent.map((s) => s.model)).toEqual(["best", "balanced"]);
  expect(sent[0]?.options.tools).toBeUndefined();
  expect(sent[0]?.options.system).toContain("<coding_plan>");
  expect(sent[0]?.options.system).not.toContain("<coding_agent>");
  expect(sent[1]?.history[0]?.content).toContain("<plan>");
  expect(sent[1]?.history[0]?.content).toContain("2. Check the rounding.");
  expect(sent[1]?.options.system).toContain("A plan was written for this task");
  const saved = await getRun(db, t, run.id);
  expect(saved).toMatchObject({
    plan: "1. Find tide.ts.\n2. Check the rounding.",
    planner: "anthropic/best",
  });
  // $1.00 for the plan (100k at $10/M) plus $0.10 for the turn.
  expect(saved?.spentMicroUsd).toBe(1_100_000);
  const logged = (await listRecentRequests(db, t)).filter((r) => r.purpose === "agent");
  expect(logged.map((r) => [r.model, r.tier ?? null])).toEqual([
    ["balanced", null],
    ["best", "best"],
  ]);
});

test("a pinned model (or the same model) does it all: no separate plan", async () => {
  const pinned = await setup(null);
  expect(pinned.sent.map((s) => s.model)).toEqual(["balanced"]);
  expect((await getRun(pinned.db, t, pinned.run.id))?.plan).toBeNull();
});

test("if planning fails, the run goes on without a plan", async () => {
  const { db, sent, run } = await setup(best, true);
  expect(sent.map((s) => s.model)).toEqual(["best", "balanced"]);
  expect(sent[1]?.history[0]?.content).not.toContain("<plan>");
  expect((await getRun(db, t, run.id))?.status).toBe("done");
});
