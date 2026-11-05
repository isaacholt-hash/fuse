// @vitest-environment node
import { startRun, type RunDeps } from "@/agent/run";
import type { RepoApi } from "@/repo/api";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, setProjectPrivacy } from "@/storage/projects";
import { addMcpServer, setProjectMcpServer } from "@/storage/mcp";
import { openTestDb } from "@/storage/testing/nodeDb";
import type { McpCallContext } from "@/mcp/api";
import { captureReview, githubSource } from "./source";
import { recordedReviewAdapter } from "./testing/scripted";
import { listRecentRequests } from "@/storage/requestLog";
const t = DEFAULT_TENANT,
  base = "a".repeat(40),
  head = "b".repeat(40),
  merge = "c".repeat(40);
async function setup(change: "none" | "head" | "path" | "missing" | "secret" = "none") {
  const db = openTestDb(),
    project = await createProject(db, t, "GitHub review");
  const server = await addMcpServer(db, t, {
    name: "Recorded GitHub",
    transport: "http",
    url: "https://example.invalid",
    command: null,
    args: [],
    envNames: [],
    network: false,
  });
  await db.execute("UPDATE mcp_servers SET builtin_kind='github' WHERE id=?", [server.id]);
  await setProjectMcpServer(db, t, project.id, server.id, true);
  const calls: {
    name: string;
    args: Record<string, unknown>;
    context: McpCallContext | undefined;
  }[] = [];
  const deps: RunDeps = {
    db,
    tenant: t,
    catalog: defaultCatalog,
    adapterFor: () => {
      throw new Error("Source capture must not call a model");
    },
    repo: new Proxy({} as RepoApi, {
      get() {
        throw new Error("GitHub review must not read local files");
      },
    }),
    mcp: {
      forProject: async () =>
        await db.select(
          "SELECT server_id AS id,'GitHub' AS name FROM project_mcp_servers WHERE project_id=?",
          [project.id],
        ),
      tools: () =>
        Promise.resolve(
          [
            "github_installations",
            "github_repositories",
            "github_pull_read",
            "github_diff_read",
            "github_file_read",
          ].map((name) => ({
            name,
            description: "recorded reader",
            inputSchema: {},
            readOnly: true,
            destructive: false,
          })),
        ),
      call: (_id, name, args, context) => {
        calls.push({ name, args, context });
        let value: unknown;
        if (name === "github_installations")
          value = { items: [{ installationId: 42, usable: true }], nextCursor: null };
        else if (name === "github_repositories")
          value = { items: [{ fullName: "Recorded/Repo" }], nextCursor: null };
        else if (name === "github_pull_read") {
          if (args.expectedHead && change === "head") throw new Error("Recorded PR head changed.");
          value = { baseCommit: base, headCommit: head };
        } else if (name === "github_diff_read")
          value = {
            baseCommit: base,
            headCommit: head,
            mergeBaseCommit: merge,
            files: [
              {
                path: change === "secret" ? "credentials.json" : "ratio.ts",
                previousPath: null,
                status: "modified",
                partial: change === "missing",
                lines: [
                  { kind: "removed", oldLine: 1, newLine: null, text: "old" },
                  { kind: "added", oldLine: null, newLine: 1, text: "new" },
                ],
              },
            ],
            partial: change === "missing",
            nextOffset: null,
          };
        else
          value = {
            commit: args.commit,
            path: change === "path" ? "other.ts" : args.path,
            lines: [{ line: 1, text: args.commit === merge ? "old" : "new" }],
            partial: false,
            nextLine: null,
          };
        return Promise.resolve({
          parts: [{ kind: "text" as const, text: JSON.stringify(value), mime: null, data: null }],
          isError: false,
        });
      },
    },
  };
  const model = defaultCatalog.models.find((m) => m.provider === "anthropic");
  if (!model) throw new Error("Missing fixture model.");
  const input = { projectId: project.id, threadId: null, model };
  const source = {
    kind: "github" as const,
    serverId: server.id,
    installationId: 42,
    owner: "Recorded",
    repo: "Repo",
    number: 5,
  };
  return { db, project, server, deps, calls, input, source };
}
test("GitHub review pins the merge base for old files and uses native context separately from arguments", async () => {
  const f = await setup(),
    snapshot = await captureReview(f.deps, f.input, f.source);
  expect(snapshot.baseCommit).toBe(merge);
  expect(snapshot.headCommit).toBe(head);
  expect(snapshot.files[0]).toMatchObject({
    oldRevision: merge,
    newRevision: head,
    oldText: "old",
    newText: "new",
  });
  expect(f.calls.filter((c) => c.name === "github_file_read").map((c) => c.args.commit)).toEqual([
    merge,
    head,
  ]);
  expect(
    f.calls.every(
      (c) => c.context?.projectId === f.project.id && c.context.provider === "anthropic",
    ),
  ).toBe(true);
  expect(
    f.calls.every((c) => !Object.hasOwn(c.args, "provider") && !Object.hasOwn(c.args, "projectId")),
  ).toBe(true);
});
test("PR URL resolves the enabled account's selected installation without exposing native IDs in the form", async () => {
  const f = await setup();
  expect(
    await githubSource(f.deps, f.input, f.server.id, "https://github.com/recorded/repo/pull/5"),
  ).toMatchObject({ installationId: 42, number: 5, owner: "recorded", repo: "repo" });
  await expect(
    githubSource(f.deps, f.input, f.server.id, "https://evil.invalid/Recorded/Repo/pull/5"),
  ).rejects.toThrow(/github.com/);
});
test("changed PRs pause capture; mismatched paths and incomplete patches become explicit omissions", async () => {
  const changed = await setup("head");
  await expect(captureReview(changed.deps, changed.input, changed.source)).rejects.toThrow(
    /head changed/,
  );
  for (const kind of ["path", "missing", "secret"] as const) {
    const f = await setup(kind),
      snapshot = await captureReview(f.deps, f.input, f.source);
    expect(snapshot.files).toEqual([]);
    expect(snapshot.limitations.length).toBeGreaterThan(0);
    if (kind === "secret") expect(f.calls.some((c) => c.name === "github_file_read")).toBe(false);
  }
});
test("project disablement, generic impostors and provider privacy deny reads before capture", async () => {
  const f = await setup();
  await setProjectMcpServer(f.db, t, f.project.id, f.server.id, false);
  await expect(captureReview(f.deps, f.input, f.source)).rejects.toThrow(/Enable/);
  expect(f.calls).toHaveLength(0);
  await setProjectMcpServer(f.db, t, f.project.id, f.server.id, true);
  await f.db.execute("UPDATE mcp_servers SET builtin_kind=NULL WHERE id=?", [f.server.id]);
  await expect(captureReview(f.deps, f.input, f.source)).rejects.toThrow(/Enable/);
  expect(f.calls).toHaveLength(0);
  await f.db.execute("UPDATE mcp_servers SET builtin_kind='github' WHERE id=?", [f.server.id]);
  await setProjectPrivacy(f.db, t, f.project.id, { mode: "local_only", allowEmbeddings: false });
  await expect(captureReview(f.deps, f.input, f.source)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
test("a GitHub review completes in the existing runner path with no linked folder or local repository access", async () => {
  const f = await setup();
  const model = defaultCatalog.models.find(
    (m) => m.provider === "anthropic" && m.id.includes("sonnet"),
  );
  if (!model) throw new Error("Missing recorded routine model.");
  f.deps.adapterFor = (provider) => recordedReviewAdapter(provider);
  const run = await startRun(f.deps, {
    ...f.input,
    model,
    planner: model,
    messageId: null,
    task: "Review this recorded pull request",
    review: f.source,
    capMicroUsd: 5_000_000,
  });
  expect(run).toMatchObject({ status: "done", review: true, mode: "plan" });
  expect(await f.db.select<{ n: number }>("SELECT COUNT(*) AS n FROM folders")).toEqual([{ n: 0 }]);
  expect(await f.db.select<{ n: number }>("SELECT COUNT(*) AS n FROM run_changes")).toEqual([
    { n: 0 },
  ]);
  expect(await listRecentRequests(f.db, t)).toHaveLength(3);
}, 15000);
