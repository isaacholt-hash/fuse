// @vitest-environment node
// M6 step 10: git in coding runs (CA-05).
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import type { ChatOptions, ProviderAdapter, StreamEvent, ToolCall } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import type { GitApi } from "@/repo/git";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, setProjectRepo } from "@/storage/projects";
import { getRun, listSteps } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { branchName, startRun, type ApprovalRequest, type RunDeps } from "./run";
import { gitArgs } from "./tools";

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

async function setup(
  calls: ToolCall[],
  opts: {
    mode: "plan" | "ask" | "auto_edit";
    answer?: boolean;
    newBranch?: boolean;
    failBranch?: boolean;
  },
) {
  const db = openTestDb();
  const project = await createProject(db, t, "Lighthouse");
  await setProjectRepo(db, t, project.id, { root: "/repo", readSecrets: false });
  const ran: string[] = [];
  const git: GitApi = {
    run: (_p, program, args) => {
      ran.push(`${program} ${args.join(" ")}`);
      if (opts.failBranch && args[0] === "switch")
        return Promise.resolve({ output: "fatal: not a git repository", exitCode: 128 });
      return Promise.resolve({
        output: args[0] === "status" ? "## main\n M a.ts\n" : "",
        exitCode: 0,
      });
    },
  };
  const asked: ApprovalRequest[] = [];
  const systems: (string | undefined)[] = [];
  let n = 0;
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(_h, m, options: ChatOptions): AsyncGenerator<StreamEvent> {
      systems.push(options.system);
      const first = n++ === 0;
      await Promise.resolve();
      if (first) for (const call of calls) yield { type: "tool_call", call };
      else yield { type: "text", text: "Done." };
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
    git,
    approve: (r) => {
      asked.push(r);
      return Promise.resolve(opts.answer ?? true);
    },
  };
  const run = await startRun(deps, {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: "Fix the tide rounding!",
    model,
    mode: opts.mode,
    ...(opts.newBranch ? { newBranch: true } : {}),
  });
  const tools = (await listSteps(db, t, run.id)).flatMap((s) => (s.kind === "tool" ? [s] : []));
  return { db, ran, asked, systems, run, tools };
}

const call = (name: string, input: Record<string, unknown> = {}): ToolCall => ({
  id: name,
  name,
  input,
});

test("status, diff and log go ahead in every mode; read-only runs can't commit", async () => {
  const { ran, asked, tools } = await setup(
    [
      call("git_status"),
      call("git_diff", { staged: false, path: "a.ts" }),
      call("git_log", { count: null }),
      call("git_commit", { message: "x", all: true }),
    ],
    { mode: "plan" },
  );
  expect(ran).toEqual([
    "git status --short --branch",
    "git diff -- a.ts",
    "git log --oneline -n 10",
  ]);
  expect(asked).toEqual([]);
  expect(tools[0]?.output).toBe("$ git status --short --branch\n## main\n M a.ts");
  expect(tools[3]).toMatchObject({ isError: true, output: "Error: this run is read-only." });
});

test("Ask: a commit asks first; Auto-edit: it goes ahead, but a push still asks", async () => {
  const ask = await setup([call("git_commit", { message: "Round tides to 0.1 m", all: true })], {
    mode: "ask",
  });
  expect(ask.asked).toEqual([
    expect.objectContaining({
      kind: "git",
      summary: "Commit everything: “Round tides to 0.1 m”",
      remote: false,
    }),
  ]);
  expect(ask.ran).toEqual(["git add -A", "git commit -m Round tides to 0.1 m"]);

  const auto = await setup([call("git_commit", { message: "x", all: false }), call("git_push")], {
    mode: "auto_edit",
    answer: false,
  });
  expect(auto.asked).toEqual([
    expect.objectContaining({ kind: "git", summary: "Push this branch to origin", remote: true }),
  ]);
  expect(auto.ran).toEqual(["git commit -m x"]);
  expect(auto.tools.map((s) => s.approval)).toEqual(["auto", "denied"]);
});

test("a pull request asks, then goes through gh", async () => {
  const { ran, asked } = await setup(
    [call("open_pull_request", { title: "Round tides", body: "Why and how.", draft: true })],
    { mode: "auto_edit" },
  );
  expect(asked[0]).toMatchObject({
    kind: "git",
    summary: "Open a draft pull request: “Round tides”",
    remote: true,
  });
  expect(ran).toEqual(["gh pr create --title Round tides --body Why and how. --draft"]);
});

test("a run can start on a branch of its own, and is told so", async () => {
  const { ran, run, systems } = await setup([], { mode: "auto_edit", newBranch: true });
  expect(ran[0]).toMatch(/^git switch --create fuse\/fix-the-tide-rounding-[0-9a-f]{4}$/);
  expect(run.branch).toMatch(/^fuse\/fix-the-tide-rounding-/);
  expect(systems[0]).toContain(`This run works on its own branch, ${run.branch ?? ""}`);
});

test("if the branch can't be made, the run stops before any turn", async () => {
  const { db, run, systems } = await setup([], {
    mode: "auto_edit",
    newBranch: true,
    failBranch: true,
  });
  expect(systems).toEqual([]);
  expect(await getRun(db, t, run.id)).toMatchObject({
    status: "error",
    note: "Couldn't make a branch: fatal: not a git repository",
  });
});

test("branch names are safe", () => {
  expect(branchName("Add a test for tides!!", "0190-abcd-1234")).toBe(
    "fuse/add-a-test-for-tides-1234",
  );
  expect(branchName("???", "x")).toBe("fuse/run-x");
  expect(gitArgs(call("git_branch", { name: "--force" }))).toEqual({
    error: 'Error: "--force" isn\'t a usable branch name.',
  });
  expect(gitArgs(call("git_branch", { name: "a..b" }))).toHaveProperty("error");
  expect(gitArgs(call("git_commit", { message: " ", all: true }))).toEqual({
    error: "Error: a commit needs a message.",
  });
});
