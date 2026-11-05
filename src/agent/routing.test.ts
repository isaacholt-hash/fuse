// @vitest-environment node
// M6 step 11: routing inside runs (CA-07, RT-14). A Best model plans in a request of its own; the
// loop stays on the routed model; summaries are on the Cheap tier (compaction.test.ts).
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import { ProviderError } from "@/providers/errors";
import type { ChatMessage, ChatOptions, ProviderAdapter, StreamEvent } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, setProjectRepo, setProjectPrivacy } from "@/storage/projects";
import { listRecentRequests } from "@/storage/requestLog";
import { getRun } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { startRun, continueRun, type RunDeps } from "./run";

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

async function setup(
  planner: CatalogModel | null,
  planFails = false,
  failureStatus = 529,
  cap = 5_000_000,
  worker = balanced,
) {
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
        throw new ProviderError("overloaded", "busy", { status: failureStatus });
      yield {
        type: "text",
        text: options.system?.includes("<run_synthesis>")
          ? "Verified final result."
          : options.system?.includes("<coding_plan>")
            ? "1. Find tide.ts.\n2. Check the rounding."
            : "Done.",
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
    model: worker,
    planner,
    capMicroUsd: cap,
  });
  return { db, sent, run, deps };
}

test("Auto: Best plans first without tools, then the routed model works with that plan", async () => {
  const { db, sent, run } = await setup(best);
  expect(sent.map((s) => s.model)).toEqual(["best", "balanced", "best"]);
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
  expect(sent[2]?.options.tools).toBeUndefined();
  expect(sent[2]?.options.system).toContain("<run_synthesis>");
  expect(JSON.parse(sent[2]?.history[0]?.content ?? "{}")).toMatchObject({ draftResult: "Done." });
  expect(saved).toMatchObject({ status: "done", routingStage: "complete" });
  // Two Best requests at $1.00 and one Balanced request at $0.10.
  expect(saved?.spentMicroUsd).toBe(2_100_000);
  const logged = (await listRecentRequests(db, t)).filter((r) => r.purpose === "agent");
  expect(logged.map((r) => [r.model, r.tier ?? null])).toEqual([
    ["best", "best"],
    ["balanced", null],
    ["best", "best"],
  ]);
});

test("a pinned model does all work without overriding its selection", async () => {
  const pinned = await setup(null);
  expect(pinned.sent.map((s) => s.model)).toEqual(["balanced"]);
  expect((await getRun(pinned.db, t, pinned.run.id))?.plan).toBeNull();
});

test("a known non-billable planner refusal pauses without bypassing required planning", async () => {
  const { db, sent, run } = await setup(best, true, 429);
  expect(sent.map((s) => s.model)).toEqual(["best"]);
  expect(await getRun(db, t, run.id)).toMatchObject({ status: "paused", routingStage: "plan" });
  expect((await listRecentRequests(db, t))[0]?.billingState).toBe("not_billed");
});

test("an ambiguous planner failure retains its hold and pauses before another paid call", async () => {
  const { db, sent, run } = await setup(best, true);
  expect(sent.map((s) => s.model)).toEqual(["best"]);
  expect((await getRun(db, t, run.id))?.status).toBe("paused");
  expect((await listRecentRequests(db, t))[0]?.billingState).toBe("unknown");
});

test("Auto still plans and synthesizes when the worker is also Best", async () => {
  const { sent } = await setup(best, false, 529, 10_000_000, best);
  expect(sent.map((s) => s.model)).toEqual(["best", "best", "best"]);
  expect(sent[0]?.options.tools).toBeUndefined();
  expect(sent[1]?.options.tools?.length).toBeGreaterThan(0);
  expect(sent[2]?.options.tools).toBeUndefined();
});

test("a cap pause resumes synthesis without repeating the planner or worker", async () => {
  const { db, sent, run, deps } = await setup(best, false, 529, 1_150_000);
  expect(run).toMatchObject({
    status: "paused",
    routingStage: "synthesis",
    spentMicroUsd: 1_100_000,
  });
  expect(sent.map((s) => s.model)).toEqual(["best", "balanced"]);
  const resumed = await continueRun(deps, run.id, { raiseCapBy: 2_000_000 });
  expect(resumed).toMatchObject({
    status: "done",
    routingStage: "complete",
    spentMicroUsd: 2_100_000,
  });
  expect(sent.map((s) => s.model)).toEqual(["best", "balanced", "best"]);
  await continueRun(deps, run.id, {});
  expect(sent).toHaveLength(3);
  expect(await db.select("SELECT * FROM request_log")).toHaveLength(3);
});

test("the Code engine rejects research before folders, messages, or execution are touched", async () => {
  const { deps, sent } = await setup(null);
  const before = await deps.db.select("SELECT id FROM runs");
  await expect(
    startRun(deps, {
      projectId: null,
      threadId: null,
      messageId: null,
      task: "Research",
      kind: "research",
      model: balanced,
    }),
  ).rejects.toThrow("restricted");
  expect(await deps.db.select("SELECT id FROM runs")).toEqual(before);
  expect(sent).toHaveLength(1);
});

test("final synthesis rechecks provider policy and sends no evidence after withdrawal", async () => {
  const { db, sent, run, deps } = await setup(best, false, 529, 1_150_000);
  if (!run.projectId) throw new Error("Missing fixture project");
  await setProjectPrivacy(db, t, run.projectId, { mode: "local_only", allowEmbeddings: false });
  const resumed = await continueRun(deps, run.id, { raiseCapBy: 2_000_000 });
  expect(resumed).toMatchObject({ status: "paused", routingStage: "synthesis" });
  expect(resumed.note).toContain("Local only");
  expect(sent).toHaveLength(2);
});

test("a malicious final tool call cannot execute and remains an unresolved charged attempt", async () => {
  const { db, run, deps } = await setup(best, false, 529, 1_150_000);
  deps.adapterFor = () => ({
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat() {
      await Promise.resolve();
      yield {
        type: "tool_call",
        call: { id: "attack", name: "write_file", input: { path: "bad.txt", content: "bad" } },
      };
    },
  });
  const resumed = await continueRun(deps, run.id, { raiseCapBy: 2_000_000 });
  expect(resumed).toMatchObject({ status: "paused", routingStage: "synthesis" });
  expect(resumed.note).toContain("cannot execute tools");
  expect(await db.select("SELECT id FROM run_changes")).toHaveLength(0);
  expect(await db.select("SELECT id FROM run_steps WHERE kind='tool'")).toHaveLength(0);
  expect((await listRecentRequests(db, t))[0]?.billingState).toBe("unknown");
});

test("unreported final usage is visibly unresolved and never stored as an actual step charge", async () => {
  const { db, run, deps } = await setup(best, false, 529, 1_150_000);
  deps.adapterFor = () => ({
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat() {
      await Promise.resolve();
      yield { type: "text", text: "Partial final answer" };
      yield {
        type: "done",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: false,
        stopReason: null,
        providerRequestId: null,
        attempts: 1,
      };
    },
  });
  const result = await continueRun(deps, run.id, { raiseCapBy: 2_000_000 });
  expect(result).toMatchObject({
    status: "paused",
    routingStage: "synthesis",
    spentMicroUsd: 1_100_000,
  });
  expect((await listRecentRequests(db, t))[0]).toMatchObject({
    billingState: "unknown",
    usage: { costMicroUsd: 0 },
  });
  expect(await db.select("SELECT cost_micro_usd FROM run_steps ORDER BY seq DESC LIMIT 1")).toEqual(
    [{ cost_micro_usd: 0 }],
  );
});

test("an unavailable planner leaves a resumable pause instead of an active run", async () => {
  const { run, deps, sent } = await setup(best, true, 429);
  deps.catalog = { ...catalog, models: [balanced] };
  const result = await continueRun(deps, run.id, {});
  expect(result).toMatchObject({ status: "paused", routingStage: "plan" });
  expect(result.note).toContain("unavailable");
  expect(sent).toHaveLength(1);
});
