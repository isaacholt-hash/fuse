// @vitest-environment node
// M6 step 12: no repository content reaches a blocked provider (SE-13, CA-09). One test per
// send path of a run: its turns, the plan, and summaries. The Rust transport checks the same
// scope again (src-tauri/src/egress.rs); these are the app's own checks.
import { unavailableLocalAdapter } from "@/providers/local/adapter";
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import type { ChatOptions, ProviderAdapter, StreamEvent, ToolCall } from "@/providers/types";
import type { ProviderId } from "@/catalog/catalog";
import type { RepoApi } from "@/repo/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { setEgressRule } from "@/storage/egress";
import { grantFolder } from "@/storage/folders";
import { createProject, setProjectPrivacy, setProjectRepo } from "@/storage/projects";
import { getRun } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { startRun, type RunDeps } from "./run";

const t = DEFAULT_TENANT;
const m = (provider: ProviderId, id: string, window = 200000): Record<string, unknown> => ({
  provider,
  id,
  display_name: id,
  context_window: window,
  max_output: 1000,
  price: { input: 1, output: 1 },
  capabilities: [],
  verified_on: "2026-10-30",
  source_url: "https://example.com",
});
const catalog = parseCatalog({
  price_version: "2026-10-30",
  models: [m("anthropic", "claude", 8000), m("openai", "gpt")],
});
const claude = catalog.models[0] as CatalogModel;
const gpt = catalog.models[1] as CatalogModel;
const big = "x".repeat(10_000);
const repo: RepoApi = {
  pick: () => Promise.resolve(null),
  check: () => Promise.reject(new Error("unused")),
  list: () => Promise.resolve([]),
  search: () => Promise.resolve([]),
  read: (_p, path) =>
    path.endsWith(".md")
      ? Promise.reject(new Error("no such file"))
      : Promise.resolve({
          path,
          content: big,
          offset: 0,
          totalBytes: big.length,
          truncated: false,
        }),
  write: () => Promise.reject(new Error("unused")),
  remove: () => Promise.reject(new Error("unused")),
  move: () => Promise.reject(new Error("unused")),
};

/** Records what each provider was sent; every request must carry the project's scope. */
function providers() {
  const sent: { provider: ProviderId; options: ChatOptions }[] = [];
  const make = (provider: ProviderId): ProviderAdapter => {
    let turn = 0;
    return {
      provider,
      listModels: () => Promise.resolve([]),
      async *streamChat(_h, model, options): AsyncGenerator<StreamEvent> {
        sent.push({ provider, options: structuredClone(options) });
        await Promise.resolve();
        const loop = Boolean(options.tools);
        const calls: ToolCall[] =
          loop && turn < 2
            ? [
                {
                  id: `r${String(turn)}`,
                  name: "read_file",
                  input: { path: `f${String(turn)}.ts`, offset: null },
                },
              ]
            : [];
        if (loop) turn++;
        yield {
          type: "text",
          text: loop ? (calls.length ? "Reading." : "Done.") : "A summary or a plan.",
        };
        for (const call of calls) yield { type: "tool_call", call };
        yield {
          type: "done",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            webSearchCalls: 0,
          },
          usageReported: true,
          stopReason: calls.length ? "tool_use" : "end_turn",
          providerRequestId: null,
          attempts: 1,
          ...(loop ? { turn: { provider, model, items: [] } } : {}),
        };
      },
    };
  };
  const adapters = { anthropic: make("anthropic"), openai: make("openai") };
  return {
    sent,
    adapterFor: (p: ProviderId) => (p === "local" ? unavailableLocalAdapter() : adapters[p]),
  };
}

async function setup(
  block: (db: ReturnType<typeof openTestDb>, projectId: string) => Promise<void>,
) {
  const db = openTestDb();
  const project = await createProject(db, t, "Health records");
  await setProjectRepo(db, t, project.id, { root: "/repo", readSecrets: false });
  await block(db, project.id);
  const { sent, adapterFor } = providers();
  const deps = (extra: Partial<RunDeps> = {}): RunDeps => ({
    db,
    tenant: t,
    catalog,
    adapterFor,
    repo,
    ...extra,
  });
  const go = (d: RunDeps, model: CatalogModel, planner: CatalogModel | null = null) =>
    startRun(d, {
      projectId: project.id,
      threadId: null,
      messageId: null,
      task: "Read the files",
      model,
      planner,
      capMicroUsd: 10_000_000,
    });
  return { db, project, sent, deps, go };
}

test("Local only: a run sends nothing anywhere, and says why", async () => {
  const { db, sent, deps, go } = await setup((db, id) =>
    setProjectPrivacy(db, t, id, { mode: "local_only", allowEmbeddings: false }),
  );
  const run = await go(deps({ summarizer: gpt }), claude, gpt);
  expect(sent).toEqual([]);
  expect((await getRun(db, t, run.id))?.note).toMatch(/Local only/);
  expect(run.status).toBe("error");
});

test("the loop: a blocked provider gets no turn", async () => {
  const { sent, deps, go } = await setup((db, id) => setEgressRule(db, t, id, "anthropic", false));
  const run = await go(deps(), claude);
  expect(sent.filter((s) => s.provider === "anthropic")).toEqual([]);
  expect(run.note).toMatch(/blocks Anthropic/);
});

test("the plan: a blocked planner isn't asked; the run goes on without a plan", async () => {
  const { sent, deps, go } = await setup((db, id) => setEgressRule(db, t, id, "openai", false));
  const run = await go(deps(), claude, gpt);
  expect(sent.filter((s) => s.provider === "openai")).toEqual([]);
  expect(run.status).toBe("done");
  expect(run.plan).toBeNull();
});

test("summaries: a blocked summarizer isn't sent the steps; the plain list is used", async () => {
  const { sent, deps, go } = await setup((db, id) => setEgressRule(db, t, id, "openai", false));
  const run = await go(deps({ summarizer: gpt }), claude);
  expect(sent.filter((s) => s.provider === "openai")).toEqual([]);
  expect(run.summary).toContain("read_file");
  expect(run.status).toBe("done");
});

test("every request a run makes carries the project's scope, for the Rust check", async () => {
  const { project, sent, deps, go } = await setup(() => Promise.resolve());
  await go(deps({ summarizer: gpt }), claude, gpt);
  expect(new Set(sent.map((s) => s.provider))).toEqual(new Set(["anthropic", "openai"]));
  expect(
    sent.every((s) => s.options.scope?.kind === "project" && s.options.scope.id === project.id),
  ).toBe(true);
});

test("WF-08: a Work run outside any project keeps the global rules", async () => {
  const { db, sent, deps } = await setup(() => Promise.resolve());
  await setEgressRule(db, t, null, "anthropic", false);
  const folder = await grantFolder(db, t, "/home/me/letters");
  const run = await startRun(deps(), {
    projectId: null,
    folders: [folder],
    threadId: null,
    messageId: null,
    task: "Summarise the letters",
    model: claude,
    kind: "work",
    capMicroUsd: 10_000_000,
  });
  expect(sent).toEqual([]);
  expect(run.status).toBe("error");
  expect(run.note).toMatch(/Anthropic/);
});
