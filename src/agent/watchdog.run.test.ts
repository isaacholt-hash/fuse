// @vitest-environment node
// M10 step 11: the stall watchdog inside a run, and the project's own limits.
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import { ProviderError } from "@/providers/errors";
import type { ProviderAdapter, StreamEvent } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, setProjectRepo, setProjectRunLimits } from "@/storage/projects";
import { addRunWait, getRun, setRunStatus } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { continueRun, DEFAULT_RUN_CAP_MICRO_USD, startRun, type RunDeps } from "./run";

const t = DEFAULT_TENANT;
const catalog = parseCatalog({
  price_version: "2026-11-01",
  models: [
    {
      provider: "anthropic",
      id: "test-claude",
      display_name: "Test Claude",
      context_window: 200000,
      max_output: 1000,
      price: { input: 2, output: 10 },
      capabilities: [],
      verified_on: "2026-11-01",
      source_url: "https://example.com",
    },
  ],
});
const model = catalog.models[0] as CatalogModel;
const repo = {
  list: () => Promise.resolve([]),
  read: () => Promise.reject(new Error("unused")),
} as unknown as RepoApi;

const done = (m: string): StreamEvent => ({
  type: "done",
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    webSearchCalls: 0,
  },
  usageReported: true,
  stopReason: "end_turn",
  providerRequestId: "req",
  attempts: 1,
  turn: { provider: "anthropic", model: m, items: [] },
});

/** Until the signal aborts, then the error a real adapter raises. */
function aborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => {
      reject(new ProviderError("aborted", "The request was stopped."));
    };
    if (signal?.aborted) fail();
    else signal?.addEventListener("abort", fail);
  });
}

/** A model that never answers. */
const silent: ProviderAdapter = {
  provider: "anthropic",
  listModels: () => Promise.resolve([]),
  async *streamChat(_h, m, _o, signal): AsyncGenerator<StreamEvent> {
    await aborted(signal);
    yield done(m); // never reached: aborted() only ever rejects
  },
};

/** A model that keeps streaming a word every 20 ms and never finishes. */
const chatty: ProviderAdapter = {
  provider: "anthropic",
  listModels: () => Promise.resolve([]),
  async *streamChat(_h, _m, _o, signal): AsyncGenerator<StreamEvent> {
    for (;;) {
      await Promise.race([
        new Promise((r) => setTimeout(r, 20)),
        aborted(signal).catch(() => undefined),
      ]);
      if (signal?.aborted) await aborted(signal);
      yield { type: "text", text: "more " };
    }
  },
};

/** A model that answers once and is done. */
const brief: ProviderAdapter = {
  provider: "anthropic",
  listModels: () => Promise.resolve([]),
  async *streamChat(_h, m): AsyncGenerator<StreamEvent> {
    await Promise.resolve();
    yield { type: "text", text: "Done." };
    yield done(m);
  },
};

async function setup(adapter: ProviderAdapter) {
  const db = openTestDb();
  const project = await createProject(db, t, "Lighthouse");
  await setProjectRepo(db, t, project.id, { root: "/repo", readSecrets: false });
  const deps: RunDeps = { db, tenant: t, catalog, adapterFor: () => adapter, repo };
  return { db, project, deps };
}

test("a run that makes no progress for its idle limit is stopped, and says so", async () => {
  const { deps, project } = await setup(silent);
  const run = await startRun(deps, {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: "Wait forever",
    model,
    idleMinutes: 0.002,
  });
  expect(run.status).toBe("stopped");
  expect(run.note).toMatch(/^Stopped: no progress for /);
});

test("a planner that never answers is stopped by the same idle limit", async () => {
  const planner: CatalogModel = { ...model, id: "test-planner", displayName: "Test Planner" };
  const planless: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(h, m, o, signal): AsyncGenerator<StreamEvent> {
      if (m === planner.id) await aborted(signal);
      yield* brief.streamChat(h, m, o, signal);
    },
  };
  const { deps, project } = await setup(planless);
  const run = await startRun(deps, {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: "Plan forever",
    model,
    planner,
    idleMinutes: 0.002,
  });
  expect(run.status).toBe("stopped");
  expect(run.note).toMatch(/^Stopped: no progress for /);
});

test("a run that keeps streaming is still stopped at its wall-clock limit", async () => {
  const { deps, project } = await setup(chatty);
  const run = await startRun(deps, {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: "Talk forever",
    model,
    wallMinutes: 0.004,
    idleMinutes: 10,
  });
  expect(run.status).toBe("stopped");
  expect(run.note).toMatch(/^Stopped: ran for /);
});

test("a project's own cap and limits apply to its runs; FUSE's defaults otherwise", async () => {
  const { db, deps, project } = await setup(brief);
  const plain = await startRun(deps, {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: "Say done",
    model,
  });
  expect(plain.status).toBe("done");
  expect(plain.capMicroUsd).toBe(DEFAULT_RUN_CAP_MICRO_USD);
  await setProjectRunLimits(db, t, project.id, { capMicroUsd: 250_000, idleMinutes: 45 });
  const capped = await startRun(deps, {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: "Say done",
    model,
  });
  expect(capped.capMicroUsd).toBe(250_000);
  // A field put back to null is the default again; the others are kept.
  await setProjectRunLimits(db, t, project.id, { capMicroUsd: null });
  const project2 = (await import("@/storage/projects")).getProject(db, t, project.id);
  expect((await project2)?.runLimits).toEqual({
    capMicroUsd: null,
    wallMinutes: null,
    idleMinutes: 45,
  });
});

test("Continue starts a new leg: its clock restarts and the time it waited is forgotten", async () => {
  const { db, deps, project } = await setup(brief);
  const run = await startRun(deps, {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: "Say done",
    model,
  });
  await setRunStatus(db, t, run.id, "stopped", "Stopped.");
  await addRunWait(db, t, run.id, 5_000);
  expect((await getRun(db, t, run.id))?.waitedMs).toBe(5_000);
  await new Promise((r) => setTimeout(r, 5));
  const again = await continueRun(deps, run.id, {});
  expect(again.status).toBe("done");
  expect(again.waitedMs).toBe(0);
  expect(again.startedAt).toBeGreaterThan(run.startedAt);
});
