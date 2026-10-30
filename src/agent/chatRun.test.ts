// @vitest-environment node
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import type { ProviderAdapter, StreamEvent, ToolCall } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { listPath } from "@/storage/messages";
import { createProject, setProjectRepo } from "@/storage/projects";
import { runsForThread } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread, setThreadProject } from "@/storage/threads";
import { continueChatRun, startChatRun } from "./chatRun";
import type { RunDeps } from "./run";

const t = DEFAULT_TENANT;
const catalog = parseCatalog({
  price_version: "2026-10-30",
  models: [
    {
      provider: "openai",
      id: "test-gpt",
      display_name: "Test GPT",
      context_window: 200000,
      max_output: 1000,
      price: { input: 2, output: 10 },
      capabilities: [],
      verified_on: "2026-10-30",
      source_url: "https://example.com",
    },
  ],
});
const model = catalog.models[0] as CatalogModel;
const repo: RepoApi = {
  pick: () => Promise.resolve(null),
  check: () => Promise.reject(new Error("unused")),
  list: () => Promise.resolve([{ path: "README.md", dir: false, size: 13, secret: false }]),
  search: () => Promise.resolve([]),
  read: () => Promise.reject(new Error("no such file")),
};

function adapterWith(turns: { text: string; calls?: ToolCall[] }[]): ProviderAdapter {
  let n = 0;
  return {
    provider: "openai",
    listModels: () => Promise.resolve([]),
    async *streamChat(_h, m): AsyncGenerator<StreamEvent> {
      const turn = turns[n++];
      await Promise.resolve();
      if (!turn) throw new Error("no more turns");
      yield { type: "text", text: turn.text };
      for (const call of turn.calls ?? []) yield { type: "tool_call", call };
      yield {
        type: "done",
        usage: {
          inputTokens: 100_000,
          outputTokens: 10_000,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: 0,
        },
        usageReported: true,
        stopReason: null,
        providerRequestId: null,
        attempts: 1,
        turn: { provider: "openai", model: m, items: [] },
      };
    },
  };
}

async function setup(turns: { text: string; calls?: ToolCall[] }[]) {
  const db = openTestDb();
  const project = await createProject(db, t, "Lighthouse");
  await setProjectRepo(db, t, project.id, { root: "/repo", readSecrets: false });
  const thread = await createThread(db, t);
  await setThreadProject(db, t, thread.id, project.id);
  const adapter = adapterWith(turns);
  const deps: RunDeps = { db, tenant: t, catalog, adapterFor: () => adapter, repo };
  return { db, deps, project, thread };
}

test("the question and the run's answer land in the chat, with the run's total cost", async () => {
  const { db, deps, project, thread } = await setup([
    {
      text: "1. List.",
      calls: [{ id: "c1", name: "list_files", input: { path: "", recursive: false } }],
    },
    { text: "There's a README." },
  ]);
  const seen: string[] = [];
  const run = await startChatRun(deps, {
    threadId: thread.id,
    projectId: project.id,
    task: "What's in the repo?",
    model,
    onProgress: (answerId, p) => seen.push(`${answerId}:${p.run.status}`),
  });
  const { path } = await listPath(db, t, thread.id);
  expect(path.map((m) => [m.role, m.content, m.status])).toEqual([
    ["user", "What's in the repo?", "complete"],
    ["assistant", "There's a README.", "complete"],
  ]);
  expect(path[1]?.usage.costMicroUsd).toBe(600_000);
  expect(path[1]?.usage.inputTokens).toBe(200_000);
  expect(run.messageId).toBe(path[1]?.id);
  expect(seen.every((s) => s.startsWith(`${path[1]?.id ?? ""}:`))).toBe(true);
  const runs = await runsForThread(db, t, thread.id);
  expect(runs.get(path[1]?.id ?? "")?.steps).toHaveLength(3);
});

test("paused at the cap: the answer says why; continuing finishes it", async () => {
  const { db, deps, project, thread } = await setup([
    {
      text: "1. List.",
      calls: [{ id: "c1", name: "list_files", input: { path: "", recursive: false } }],
    },
    { text: "There's a README." },
  ]);
  const paused = await startChatRun(deps, {
    threadId: thread.id,
    projectId: project.id,
    task: "Look",
    model,
    capMicroUsd: 300_000,
  });
  let answer = (await listPath(db, t, thread.id)).path[1];
  expect(answer).toMatchObject({ status: "stopped", content: "1. List." });
  expect(answer?.errorMessage).toMatch(/cost cap/);
  await continueChatRun(deps, paused.id, { raiseCapBy: 1_000_000 });
  answer = (await listPath(db, t, thread.id)).path[1];
  expect(answer).toMatchObject({
    status: "complete",
    content: "There's a README.",
    errorMessage: null,
  });
  expect(answer?.usage.costMicroUsd).toBe(600_000);
});
