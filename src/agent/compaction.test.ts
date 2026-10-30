// @vitest-environment node
// M6 step 9: a run that outgrows its budget summarizes earlier steps and carries on (CA-08).
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import type {
  ChatMessage,
  ChatOptions,
  ProviderAdapter,
  StreamEvent,
  ToolCall,
} from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, setProjectRepo } from "@/storage/projects";
import { listRecentRequests } from "@/storage/requestLog";
import { createRun, getRun, markInterruptedRuns } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { historyFromSteps, runBudget, startRun, type RunDeps } from "./run";

const t = DEFAULT_TENANT;
// A tiny window, so two big reads go past half of it.
const catalog = parseCatalog({
  price_version: "2026-10-30",
  models: [
    {
      provider: "anthropic",
      id: "tiny",
      display_name: "Tiny",
      context_window: 8000,
      max_output: 1000,
      price: { input: 1, output: 1 },
      capabilities: [],
      verified_on: "2026-10-30",
      source_url: "https://example.com",
    },
  ],
});
const model = catalog.models[0] as CatalogModel;
const big = "x".repeat(10_000);
const repo: RepoApi = {
  pick: () => Promise.resolve(null),
  check: () => Promise.reject(new Error("unused")),
  list: () => Promise.resolve([]),
  search: () => Promise.resolve([]),
  read: (_p, path) =>
    Promise.resolve({ path, content: big, offset: 0, totalBytes: big.length, truncated: false }),
  write: () => Promise.reject(new Error("unused")),
  remove: () => Promise.reject(new Error("unused")),
  move: () => Promise.reject(new Error("unused")),
};

function adapter() {
  const sent: { history: ChatMessage[]; options: ChatOptions }[] = [];
  let turn = 0;
  const a: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(history, m, options): AsyncGenerator<StreamEvent> {
      sent.push({ history: structuredClone(history), options: structuredClone(options) });
      await Promise.resolve();
      const summary = !options.tools;
      const calls: ToolCall[] =
        !summary && turn < 2
          ? [
              {
                id: `r${String(turn)}`,
                name: "read_file",
                input: { path: `f${String(turn)}.ts`, offset: null },
              },
            ]
          : [];
      if (!summary) turn++;
      yield {
        type: "text",
        text: summary
          ? "- Read f0.ts and f1.ts: both are all x."
          : calls.length
            ? "Reading."
            : "Done.",
      };
      for (const call of calls) yield { type: "tool_call", call };
      yield {
        type: "done",
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: true,
        stopReason: calls.length ? "tool_use" : "end_turn",
        providerRequestId: null,
        attempts: 1,
        ...(summary
          ? {}
          : { turn: { provider: "anthropic" as const, model: m, items: [{ t: turn }] } }),
      };
    },
  };
  return { a, sent };
}

async function setup(withSummarizer: boolean) {
  const db = openTestDb();
  const project = await createProject(db, t, "Lighthouse");
  await setProjectRepo(db, t, project.id, { root: "/repo", readSecrets: false });
  const { a, sent } = adapter();
  const deps: RunDeps = {
    db,
    tenant: t,
    catalog,
    adapterFor: () => a,
    repo,
    ...(withSummarizer ? { summarizer: model } : {}),
  };
  const run = await startRun(deps, {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: "Read both files",
    model,
  });
  return { db, sent, run, project };
}

test("past the budget, earlier steps are summarized by the Cheap tier and the loop goes on from there", async () => {
  expect(runBudget(model)).toBe(4000);
  const { db, sent, run } = await setup(true);
  expect(run.status).toBe("done");
  const summaryCall = sent.find((s) => !s.options.tools);
  expect(summaryCall?.history[0]?.content).toContain("read_file");
  const after = sent.at(-1)?.history ?? [];
  // A fresh loop: the task with the summary, then only what came after it.
  expect(after[0]?.content).toContain("<progress_so_far>");
  expect(after[0]?.content).toContain("- Read f0.ts and f1.ts: both are all x.");
  expect(after.some((m) => m.toolResults?.some((r) => r.callId === "r0"))).toBe(false);
  const saved = await getRun(db, t, run.id);
  expect(saved?.summaryUpto).toBeGreaterThan(0);
  expect((await listRecentRequests(db, t)).some((r) => r.purpose === "summary")).toBe(true);
});

test("without a Cheap model the steps are listed instead", async () => {
  const { sent } = await setup(false);
  expect(sent.every((s) => s.options.tools)).toBe(true);
  const last = sent.at(-1)?.history[0]?.content ?? "";
  expect(last).toContain("<progress_so_far>");
  expect(last).toContain('read_file {"path":"f0.ts","offset":null}');
});

test("historyFromSteps skips summarized steps; a run left working when FUSE closed is stopped", async () => {
  const h = historyFromSteps(
    "Task",
    [
      {
        kind: "model",
        id: "a",
        seq: 1,
        text: "old",
        native: null,
        requestId: null,
        costMicroUsd: 0,
      },
      {
        kind: "model",
        id: "b",
        seq: 2,
        text: "new",
        native: null,
        requestId: null,
        costMicroUsd: 0,
      },
    ],
    { text: "did old", upto: 1 },
  );
  expect(h.map((m) => m.content)).toEqual([expect.stringContaining("did old") as string, "new"]);

  const db = openTestDb();
  const project = await createProject(db, t, "P");
  const r = await createRun(db, t, {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: "x",
    provider: "anthropic",
    model: "tiny",
    capMicroUsd: 1,
  });
  expect(await markInterruptedRuns(db, t)).toBe(1);
  expect(await getRun(db, t, r.id)).toMatchObject({
    status: "stopped",
    note: "FUSE closed while it was working.",
  });
});
