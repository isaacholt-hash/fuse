// @vitest-environment node
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import type { ChatOptions, ProviderAdapter, StreamEvent } from "@/providers/types";
import { ProviderError } from "@/providers/errors";
import { startRun, continueRun, type RunDeps } from "@/agent/run";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, setProjectRepo, setProjectPrivacy } from "@/storage/projects";
import { listRecentRequests } from "@/storage/requestLog";
import { getRun, listChanges, listSteps, setRunStatus } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import type { RepoApi } from "@/repo/api";
import { snapshot, finding } from "./testing/fixtures";
import * as storage from "./storage";
const t = DEFAULT_TENANT;
const catalog = parseCatalog({
  price_version: "2026-11-05",
  models: ["balanced", "best"].map((id) => ({
    provider: "anthropic",
    id,
    display_name: id,
    context_window: 200000,
    max_output: 1000,
    price: { input: 1, output: 1 },
    capabilities: [],
    verified_on: "2026-11-05",
    source_url: "https://example.invalid",
  })),
});
async function setup(
  options: { invalid?: boolean; ambiguous?: boolean; tools?: boolean; cap?: number } = {},
) {
  const db = openTestDb(),
    project = await createProject(db, t, "Review fixture");
  await setProjectRepo(db, t, project.id, { root: "/recorded-repo", readSecrets: false });
  const folder = (
    await db.select<{ id: string }>(
      "SELECT folder_id AS id FROM project_folders WHERE project_id=?",
      [project.id],
    )
  )[0];
  if (!folder) throw new Error("Missing fixture folder.");
  const calls: { model: string; options: ChatOptions }[] = [],
    write = vi.fn(() => Promise.reject(new Error("Review must never write")));
  const repo: RepoApi = {
    pick: () => Promise.resolve(null),
    check: () => Promise.reject(new Error("not used")),
    list: () => Promise.resolve([]),
    read: () => Promise.reject(new Error("live file read forbidden")),
    search: () => Promise.resolve([]),
    write,
    remove: write,
    move: write,
  };
  let invalid = options.invalid;
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(_history, model, config): AsyncGenerator<StreamEvent> {
      await Promise.resolve();
      calls.push({ model, options: config });
      if (options.ambiguous && calls.length === 2)
        throw new ProviderError("network", "Recorded ambiguous response.");
      if (options.tools && calls.length === 2) {
        yield {
          type: "tool_call",
          call: {
            id: "malicious",
            name: "write_file",
            input: { path: "ratio.ts", content: "changed" },
          },
        };
        return;
      }
      const final = String(_history[0]?.content).includes("Return only one JSON object");
      yield {
        type: "text",
        text: final
          ? JSON.stringify({
              snapshotId: snapshot.id,
              findings: [invalid ? { ...finding, startLine: 999, endLine: 999 } : finding],
              limitations: ["Recorded fixture; no tests executed."],
            })
          : "Inspect divisor changes and their triggering inputs.",
      };
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
        stopReason: "end_turn",
        providerRequestId: null,
        attempts: 1,
        turn: { provider: "anthropic", model, items: [] },
      };
    },
  };
  const deps: RunDeps = {
    db,
    tenant: t,
    catalog,
    repo,
    adapterFor: () => adapter,
    git: { run: write, snapshot: () => Promise.resolve(structuredClone(snapshot)) },
    exec: { run: write },
    mcp: { forProject: () => Promise.resolve([]), tools: () => Promise.resolve([]), call: write },
  };
  const worker = catalog.models[0] as CatalogModel,
    best = catalog.models[1] as CatalogModel;
  const input = {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: "Review the divisor change",
    model: worker,
    planner: best,
    review: { kind: "changes" as const, folderId: folder.id },
    capMicroUsd: options.cap ?? 1_000_000,
  };
  return {
    db,
    project,
    deps,
    calls,
    write,
    input,
    setValid: () => {
      invalid = false;
    },
  };
}
test("review uses staged models and accounting without dispatching execution tools", async () => {
  const f = await setup(),
    run = await startRun(f.deps, f.input);
  expect(run).toMatchObject({ review: true, mode: "plan", status: "done", spentMicroUsd: 60 });
  expect(f.calls.map((c) => c.model)).toEqual(["best", "balanced", "best"]);
  expect(f.calls.every((c) => c.options.tools?.length === 0 && c.options.noRetry)).toBe(true);
  expect(f.write).not.toHaveBeenCalled();
  expect(await listChanges(f.db, t, run.id)).toEqual([]);
  const final = (await listSteps(f.db, t, run.id)).at(-1);
  expect(final?.kind).toBe("model");
  expect(final?.kind === "model" ? final.text : "").toContain("[P1] Preserve the divisor");
  expect(await listRecentRequests(f.db, t)).toHaveLength(3);
});
test("invalid findings retain actual costs and raw local evidence, then require explicit continuation", async () => {
  const f = await setup({ invalid: true }),
    run = await startRun(f.deps, f.input);
  expect(run).toMatchObject({ status: "paused", spentMicroUsd: 60 });
  expect(f.calls).toHaveLength(3);
  const rejected = (await listSteps(f.db, t, run.id)).at(-1);
  expect(rejected?.kind === "model" ? rejected.text : "").toContain("No findings were accepted");
  const op = (
    await f.db.select<{ result: string }>(
      "SELECT result FROM review_operations WHERE run_id=? AND stage='final'",
      [run.id],
    )
  )[0];
  expect(op?.result).toContain("999");
  f.setValid();
  const resumed = await continueRun(f.deps, run.id, {});
  expect(resumed).toMatchObject({ status: "done", spentMicroUsd: 80 });
  expect(f.calls).toHaveLength(4);
  expect(f.write).not.toHaveBeenCalled();
});
test("cap refusal dispatches no model request and preserves the snapshot", async () => {
  const f = await setup({ cap: 1 }),
    run = await startRun(f.deps, f.input);
  expect(run.status).toBe("paused");
  expect(f.calls).toHaveLength(0);
  expect((await storage.load(f.deps, run.id)).stage).toBe("plan");
  expect((await continueRun(f.deps, run.id, { raiseCapBy: 1_000_000 })).status).toBe("done");
});
test("ambiguous dispatch is held without retry; a forbidden tool can never write", async () => {
  for (const option of [{ ambiguous: true }, { tools: true }]) {
    const f = await setup(option),
      run = await startRun(f.deps, f.input);
    expect(run.status).toBe("paused");
    expect(f.calls).toHaveLength(2);
    expect(f.write).not.toHaveBeenCalled();
    expect(run.note).toContain("No automatic retry");
    expect(
      (
        await f.db.select<{ state: string }>(
          "SELECT state FROM request_reservations WHERE run_id=? ORDER BY created_at,id",
          [run.id],
        )
      ).some((r) => r.state === "unknown"),
    ).toBe(true);
  }
});
test("a missing or replicated review checkpoint cannot fall back to generic Code", async () => {
  const f = await setup({ cap: 1 }),
    run = await startRun(f.deps, f.input);
  await f.db.execute("DELETE FROM review_state WHERE run_id=?", [run.id]);
  expect((await getRun(f.db, t, run.id))?.review).toBe(true);
  await expect(continueRun(f.deps, run.id, {})).rejects.toThrow(/snapshot is unavailable/);
  expect(f.calls).toHaveLength(0);
  expect(f.write).not.toHaveBeenCalled();
});
test("concurrent continuation, project privacy and stale owners cannot dispatch twice", async () => {
  const f = await setup({ cap: 1 }),
    run = await startRun(f.deps, f.input);
  const lease = await storage.claim(f.deps, run.id);
  await expect(storage.claim(f.deps, run.id)).rejects.toThrow(/already running/);
  await setRunStatus(f.db, t, run.id, "stopped");
  await expect(storage.begin(f.deps, run.id, lease, "plan")).rejects.toThrow();
  await setProjectPrivacy(f.db, t, f.project.id, { mode: "local_only", allowEmbeddings: false });
  const resumed = await continueRun(f.deps, run.id, {});
  expect(resumed.status).toBe("paused");
  expect(f.calls).toHaveLength(0);
});
test("no eligible changes produce a local result without any provider request", async () => {
  const f = await setup();
  if (!f.deps.git) throw new Error("Missing fixture Git API.");
  f.deps.git.snapshot = () => Promise.resolve({ ...structuredClone(snapshot), files: [] });
  const run = await startRun(f.deps, f.input);
  expect(run).toMatchObject({ status: "done", spentMicroUsd: 0, review: true });
  expect(f.calls).toHaveLength(0);
  expect(await listRecentRequests(f.db, t)).toHaveLength(0);
  const steps = await listSteps(f.db, t, run.id);
  expect(
    steps.some(
      (s) =>
        s.kind === "tool" &&
        s.call.name === "review_result" &&
        s.output.includes("No provider request was made"),
    ),
  ).toBe(true);
});
test("a crash after committing the final response completes on explicit Continue without another charge", async () => {
  const f = await setup(),
    batch = f.db.batch.bind(f.db);
  let crash = true;
  f.db.batch = (statements) => {
    if (
      crash &&
      statements.some(
        (s) => s.sql.startsWith("UPDATE runs SET status=") && s.params?.[0] === "done",
      )
    ) {
      crash = false;
      return Promise.reject(new Error("Recorded crash before completion publication."));
    }
    return batch(statements);
  };
  const run = await startRun(f.deps, f.input);
  expect(run.status).toBe("paused");
  expect((await storage.load(f.deps, run.id)).stage).toBe("finished");
  expect(f.calls).toHaveLength(3);
  expect((await continueRun(f.deps, run.id, {})).status).toBe("done");
  expect(f.calls).toHaveLength(3);
  expect(await listRecentRequests(f.db, t)).toHaveLength(3);
});
