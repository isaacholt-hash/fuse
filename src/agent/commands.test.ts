// @vitest-environment node
// M6 step 7: commands in coding runs (CA-03). Each asks first; nothing runs without a yes.
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import type { ProviderAdapter, StreamEvent, ToolCall } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import type { ExecApi, ExecResult } from "@/repo/exec";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, setProjectRepo } from "@/storage/projects";
import { listSteps } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { startRun, type ApprovalRequest, type RunDeps } from "./run";
import { commandOutput, MAX_TOOL_OUTPUT_CHARS } from "./tools";

const t = DEFAULT_TENANT;
const catalog = parseCatalog({
  price_version: "2026-10-30",
  models: [
    {
      provider: "anthropic",
      id: "test-claude",
      display_name: "Test Claude",
      context_window: 200000,
      max_output: 1000,
      price: { input: 1, output: 1 },
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
  list: () => Promise.resolve([]),
  search: () => Promise.resolve([]),
  read: () => Promise.reject(new Error("no such file")),
  write: () => Promise.reject(new Error("unused")),
  remove: () => Promise.reject(new Error("unused")),
  move: () => Promise.reject(new Error("unused")),
};

const ok: ExecResult = {
  output: "3 passed\n",
  exitCode: 0,
  timedOut: false,
  stopped: false,
  truncated: false,
  elapsedMs: 1500,
};

async function setup(opts: {
  approve?: (r: ApprovalRequest) => Promise<boolean>;
  result?: ExecResult;
  mode?: "plan" | "auto_edit";
}) {
  const db = openTestDb();
  const project = await createProject(db, t, "Lighthouse");
  await setProjectRepo(db, t, project.id, { root: "/repo", readSecrets: false });
  const ran: { command: string; timeoutSecs: number | undefined }[] = [];
  const exec: ExecApi = {
    run: (_p, command, { timeoutSecs, onOutput }) => {
      ran.push({ command, timeoutSecs });
      onOutput?.("3 passed\n");
      return Promise.resolve(opts.result ?? ok);
    },
  };
  const call: ToolCall = {
    id: "c1",
    name: "run_command",
    input: { command: "pnpm test", timeout_seconds: null },
  };
  let n = 0;
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(_h, m): AsyncGenerator<StreamEvent> {
      const first = n++ === 0;
      await Promise.resolve();
      yield { type: "text", text: first ? "Running the tests." : "Done." };
      if (first) yield { type: "tool_call", call };
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
        stopReason: first ? "tool_use" : "end_turn",
        providerRequestId: null,
        attempts: 1,
        turn: { provider: "anthropic", model: m, items: [] },
      };
    },
  };
  const deps: RunDeps = {
    db,
    tenant: t,
    catalog,
    adapterFor: () => adapter,
    repo,
    exec,
    ...(opts.approve ? { approve: opts.approve } : {}),
  };
  const r = await startRun(deps, {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: "Run the tests",
    model,
    mode: opts.mode ?? "auto_edit",
  });
  const tool = (await listSteps(db, t, r.id)).find((s) => s.kind === "tool");
  return { ran, tool, run: r };
}

test("allowed: it runs in the repo, and the model gets the output and exit code", async () => {
  const asked: ApprovalRequest[] = [];
  const { ran, tool } = await setup({
    approve: (req) => {
      asked.push(req);
      return Promise.resolve(true);
    },
  });
  expect(asked).toEqual([
    {
      runId: expect.any(String) as string,
      kind: "command",
      command: "pnpm test",
      destructive: null,
    },
  ]);
  expect(ran).toEqual([{ command: "pnpm test", timeoutSecs: 120 }]);
  expect(tool).toMatchObject({
    isError: false,
    output: "$ pnpm test\n3 passed\n[exit code 0, 1.5 s]",
  });
});

test("declined, or nobody to ask: nothing runs", async () => {
  const declined = await setup({ approve: () => Promise.resolve(false) });
  expect(declined.ran).toEqual([]);
  expect(declined.tool).toMatchObject({
    isError: true,
    output: "Error: the user declined to run `pnpm test`.",
  });
  const nobody = await setup({});
  expect(nobody.ran).toEqual([]);
  expect(nobody.tool?.kind === "tool" && nobody.tool.output).toMatch(/approval/);
});

test("read-only runs never run commands", async () => {
  const { ran, tool } = await setup({ approve: () => Promise.resolve(true), mode: "plan" });
  expect(ran).toEqual([]);
  expect(tool).toMatchObject({ isError: true, output: "Error: this run is read-only." });
});

test("a failing command is an error result the model can act on", async () => {
  const { tool, run } = await setup({
    approve: () => Promise.resolve(true),
    result: { ...ok, output: "1 failed\n", exitCode: 1 },
  });
  expect(tool).toMatchObject({
    isError: true,
    output: "$ pnpm test\n1 failed\n[exit code 1, 1.5 s]",
  });
  expect(run.status).toBe("done");
});

test("long output keeps its start and its end; time limits and stops say so", () => {
  const long = `${"a".repeat(30_000)}${"b".repeat(30_000)}END`;
  const out = commandOutput("x", { ...ok, output: long }, 120);
  expect(out.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 200);
  expect(out).toMatch(/^\$ x\naaa/);
  expect(out).toContain("characters cut");
  expect(out).toMatch(/bbbEND\n\[exit code 0/);
  expect(commandOutput("x", { ...ok, output: "", timedOut: true, exitCode: null }, 30)).toBe(
    "$ x\n[stopped: it ran past the 30 s time limit]",
  );
  expect(commandOutput("x", { ...ok, stopped: true, exitCode: null, truncated: true }, 30)).toBe(
    "$ x\n3 passed\n[output past 1 MB wasn't kept]\n[stopped by the user]",
  );
});

test("Stop while a command waits for your OK ends the run without running it", async () => {
  const db = openTestDb();
  const project = await createProject(db, t, "Lighthouse");
  await setProjectRepo(db, t, project.id, { root: "/repo", readSecrets: false });
  const ran: string[] = [];
  const ac = new AbortController();
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(_h, m): AsyncGenerator<StreamEvent> {
      await Promise.resolve();
      yield {
        type: "tool_call",
        call: {
          id: "c1",
          name: "run_command",
          input: { command: "rm -rf build", timeout_seconds: null },
        },
      };
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
        stopReason: "tool_use",
        providerRequestId: null,
        attempts: 1,
        turn: { provider: "anthropic", model: m, items: [] },
      };
    },
  };
  const deps: RunDeps = {
    db,
    tenant: t,
    catalog,
    adapterFor: () => adapter,
    repo,
    exec: { run: (_p, c) => (ran.push(c), Promise.resolve(ok)) },
    // Never answers: the user walks away, then presses Stop.
    approve: () => {
      setTimeout(() => {
        ac.abort();
      }, 10);
      return new Promise<boolean>(() => undefined);
    },
  };
  const r = await startRun(deps, {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: "Clean",
    model,
    mode: "auto_edit",
    signal: ac.signal,
  });
  expect(ran).toEqual([]);
  expect(r.status).toBe("stopped");
});
