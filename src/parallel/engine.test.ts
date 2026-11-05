// @vitest-environment node
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import { startRun, continueRun, type ApprovalRequest, type RunDeps } from "@/agent/run";
import type { ProviderAdapter, StreamEvent, ToolCall } from "@/providers/types";
import { ProviderError } from "@/providers/errors";
import type { RepoApi } from "@/repo/api";
import type { GitApi } from "@/repo/git";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createProject, setProjectRepo } from "@/storage/projects";
import { grantFolder } from "@/storage/folders";
import { createRun, getRun, listSteps, listChanges, setRunFolders } from "@/storage/runs";
import { switchProjectTool } from "@/storage/projectTools";

const catalog = parseCatalog({
  price_version: "2026-11-05",
  models: [
    {
      provider: "anthropic",
      id: "fixture",
      display_name: "Recorded model",
      context_window: 200000,
      max_output: 1000,
      price: { input: 1, output: 1 },
      capabilities: [],
      verified_on: "2026-11-05",
      source_url: "https://example.invalid/fixture",
    },
  ],
});
const model = catalog.models[0] as CatalogModel;
const call = (name: string, input: Record<string, unknown>): ToolCall => ({
  id: name,
  name,
  input,
});

async function fixture(
  options: {
    denied?: boolean;
    mode?: "ask" | "plan";
    lowerCap?: boolean;
    waitChildren?: boolean;
    forcedChildTools?: boolean;
    commands?: boolean;
  } = {},
) {
  const db = openTestDb();
  const project = await createProject(db, tenant, "Parallel fixture");
  await setProjectRepo(db, tenant, project.id, { root: "/recorded/parent", readSecrets: false });
  const folders = await db.select<{ id: string }>("SELECT id FROM folders");
  const parentFolder = folders[0]?.id ?? "missing";
  const files = new Map<string, Map<string, string>>([
    [parentFolder, new Map([["result.txt", "dirty parent"]])],
  ]);
  const writes: { folder: string; path: string; content: string }[] = [];
  const repo: RepoApi = {
    pick: () => Promise.resolve(null),
    check: () => Promise.reject(new Error("unused")),
    list: () => Promise.resolve([]),
    search: () => Promise.resolve([]),
    read: (folder, path) => {
      const content = files.get(folder)?.get(path);
      if (content === undefined) return Promise.reject(new Error("No such file."));
      return Promise.resolve({
        path,
        content,
        offset: 0,
        totalBytes: content.length,
        truncated: false,
      });
    },
    write: (folder, path, content) => {
      const target = files.get(folder);
      if (!target) return Promise.reject(new Error("Folder not granted."));
      const before = target.get(path) ?? null;
      target.set(path, content);
      writes.push({ folder, path, content });
      return Promise.resolve({ path, before });
    },
    remove: () => Promise.reject(new Error("unused")),
    move: () => Promise.reject(new Error("unused")),
  };
  const prepared: string[] = [];
  let preparations = 0;
  const asked: ApprovalRequest[] = [];
  const base = { commit: "a".repeat(40), statusHash: "b".repeat(64), folderId: parentFolder };
  const git: GitApi = {
    run: () => Promise.reject(new Error("Child Git must never execute.")),
    childBase: () => Promise.resolve(base),
    prepareChildren: async (request) => {
      preparations++;
      const parent = await getRun(db, tenant, request.parentId);
      if (!parent) throw new Error("Missing parent.");
      for (const [ordinal, task] of request.tasks.entries()) {
        const child = await createRun(db, tenant, {
          projectId: project.id,
          threadId: null,
          messageId: null,
          task: `Child task ${task}`,
          provider: parent.provider,
          model: parent.model,
          capMicroUsd: parent.capMicroUsd,
          mode: parent.mode,
        });
        const folder = await grantFolder(db, tenant, `/recorded/child-${String(ordinal)}`);
        files.set(folder.id, new Map());
        await setRunFolders(db, tenant, child.id, [{ folderId: folder.id, label: "child" }]);
        await db.execute(
          "UPDATE runs SET parent_run_id=?,status='paused',routing_stage='work',branch=? WHERE id=?",
          [parent.id, `fuse/child/${child.id}`, child.id],
        );
        await db.execute(
          "INSERT INTO code_children(child_id,workspace_id,user_id,parent_id,dispatch_id,model_step_id,call_id,request,ordinal,parent_folder_id,folder_id,base_revision,path,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'ready',1,1)",
          [
            child.id,
            tenant.workspaceId,
            tenant.userId,
            parent.id,
            "dispatch",
            request.modelStepId,
            request.callId,
            JSON.stringify(request),
            ordinal,
            parentFolder,
            folder.id,
            base.commit,
            `/recorded/child-${String(ordinal)}`,
          ],
        );
        prepared.push(child.id);
      }
      return prepared.map((id) => ({ id, state: "ready" as const }));
    },
  };
  const executions: { folder: string; network: boolean; sandbox: string[] }[] = [];
  const counts = new Map<string, number>();
  const sent: { key: string; tools: string[] }[] = [];
  let startedChildren = 0;
  let ready = () => {};
  const bothChildren = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(history, m, request, signal): AsyncGenerator<StreamEvent> {
      const key = history[0]?.content ?? "";
      const child = key.startsWith("Child task ");
      const turn = counts.get(key) ?? 0;
      counts.set(key, turn + 1);
      sent.push({ key, tools: (request.tools ?? []).map((t) => t.name) });
      if (child && options.waitChildren) {
        if (++startedChildren === 2) ready();
        await new Promise<void>((_resolve, reject) => {
          const stop = () => {
            reject(new ProviderError("aborted", "Recorded interruption."));
          };
          if (signal?.aborted) stop();
          else signal?.addEventListener("abort", stop, { once: true });
        });
      }
      const calls =
        turn === 0
          ? child
            ? options.forcedChildTools
              ? [
                  call("delegate_code", { tasks: ["recursive"] }),
                  call("git_push", {}),
                  call("git_status", {}),
                ]
              : options.commands
                ? [call("run_command", { command: "recorded-command", timeout_seconds: null })]
                : [call("write_file", { path: "result.txt", content: key })]
            : [call("delegate_code", { tasks: ["alpha", "beta"] })]
          : [];
      yield {
        type: "text",
        text: child ? "Child result retained." : "Parent result; no integration.",
      };
      for (const c of calls) yield { type: "tool_call", call: c };
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
        turn: { provider: "anthropic", model: m, items: [] },
      };
    },
  };
  const deps: RunDeps = {
    db,
    tenant,
    catalog,
    adapterFor: () => adapter,
    repo,
    git,
    ...(options.commands
      ? {
          exec: {
            sandboxKind: () => Promise.resolve("bubblewrap" as const),
            run: (
              folder: string,
              _command: string,
              opts: Parameters<import("@/repo/exec").ExecApi["run"]>[2],
            ) => {
              const network = opts.sandbox?.network ?? opts.network ?? false;
              executions.push({ folder, network, sandbox: opts.sandbox?.folderIds ?? [] });
              return Promise.resolve({
                output: network ? "Recorded success" : "Could not resolve host",
                exitCode: network ? 0 : 1,
                timedOut: false,
                stopped: false,
                truncated: false,
                elapsedMs: 1,
              });
            },
          },
        }
      : {}),
    approve: async (req) => {
      asked.push(req);
      if (options.lowerCap && req.kind === "git")
        await db.execute("UPDATE runs SET cap_micro_usd=100 WHERE id=?", [req.runId]);
      return options.commands && (req.kind === "command" || req.kind === "network")
        ? "always"
        : !options.denied;
    },
  };
  const start = (signal?: AbortSignal) =>
    startRun(deps, {
      projectId: project.id,
      threadId: null,
      messageId: null,
      task: "Parent task",
      mode: options.mode ?? "ask",
      model,
      ...(signal ? { signal } : {}),
      capMicroUsd: 1_000_000,
    });
  return {
    db,
    deps,
    project,
    start,
    parentFolder,
    files,
    writes,
    asked,
    prepared,
    sent,
    bothChildren,
    executions,
    get preparations() {
      return preparations;
    },
  };
}

test("approved children edit the same path in separate folders, with one combined receipt ledger and no integration", async () => {
  const f = await fixture();
  const parent = await f.start();
  expect(parent.status).toBe("done");
  expect(f.preparations).toBe(1);
  expect(f.prepared).toHaveLength(2);
  expect(f.writes).toHaveLength(2);
  expect(new Set(f.writes.map((w) => w.folder)).size).toBe(2);
  expect(f.writes.every((w) => w.folder !== f.parentFolder)).toBe(true);
  expect(f.files.get(f.parentFolder)?.get("result.txt")).toBe("dirty parent");
  const children = await Promise.all(f.prepared.map((id) => getRun(f.db, tenant, id)));
  expect(children.every((c) => c?.parentRunId === parent.id && c.status === "done")).toBe(true);
  expect(parent.spentMicroUsd).toBe(120);
  expect(children.map((c) => c?.spentMicroUsd)).toEqual([40, 40]);
  expect(await f.db.select("SELECT cost_micro_usd FROM request_log")).toHaveLength(6);
  expect(await listChanges(f.db, tenant, parent.id)).toEqual([]);
  expect(await f.db.select("SELECT state FROM code_children ORDER BY ordinal")).toEqual([
    { state: "complete" },
    { state: "complete" },
  ]);
  expect(f.asked.filter((a) => a.kind === "git")).toHaveLength(1);
  expect(f.asked.filter((a) => a.kind === "edit")).toHaveLength(2);
  for (const request of f.sent.filter((s) => s.key.startsWith("Child task ")))
    expect(request.tools).not.toEqual(expect.arrayContaining(["delegate_code", "git_push"]));
  const result = (await listSteps(f.db, tenant, parent.id)).find(
    (s) => s.kind === "tool" && s.call.name === "delegate_code",
  );
  expect(result).toMatchObject({ isError: false, approval: "you" });
  expect(result?.kind === "tool" && JSON.parse(result.output)).toMatchObject({
    integrated: false,
    partial: false,
  });
  await expect(continueRun(f.deps, f.prepared[0] ?? "", { raiseCapBy: 1000 })).rejects.toThrow(
    "parent",
  );
});

test.each(["denied", "plan", "disabled", "unavailable"] as const)(
  "%s delegation creates no child or worktree",
  async (kind) => {
    const f = await fixture({ denied: kind === "denied", mode: kind === "plan" ? "plan" : "ask" });
    if (kind === "disabled")
      await switchProjectTool(f.db, tenant, f.project.id, "delegate_code", false);
    if (kind === "unavailable" && f.deps.git) delete f.deps.git.prepareChildren;
    await f.start();
    expect(f.preparations).toBe(0);
    expect(f.prepared).toEqual([]);
    expect(await f.db.select("SELECT id FROM runs")).toHaveLength(1);
    expect(f.writes).toEqual([]);
  },
);

test("a reduced combined cap pauses before either child dispatches and never calls a provider for them", async () => {
  const f = await fixture({ lowerCap: true });
  const parent = await f.start();
  expect(parent.status).toBe("paused");
  expect(f.prepared).toHaveLength(2);
  expect(f.sent).toHaveLength(1);
  expect(f.writes).toEqual([]);
  expect(parent.spentMicroUsd).toBe(20);
  expect(await f.db.select("SELECT id FROM request_log")).toHaveLength(1);
  expect(await f.db.select("SELECT id FROM request_reservations WHERE state='dispatched'")).toEqual(
    [],
  );
});

test("children cannot force recursive delegation or Git even when a model returns an unoffered tool", async () => {
  const f = await fixture({ forcedChildTools: true });
  const parent = await f.start();
  expect(parent.status).toBe("done");
  expect(f.preparations).toBe(1);
  for (const id of f.prepared) {
    const tools = (await listSteps(f.db, tenant, id)).filter((s) => s.kind === "tool");
    expect(tools).toHaveLength(3);
    expect(tools.every((t) => t.isError && t.output.includes("parent"))).toBe(true);
  }
  expect(f.writes).toEqual([]);
});

test.each(["signal", "database"] as const)(
  "parent %s Stop reaches both children and retains ambiguous billing without replay",
  async (mode) => {
    const f = await fixture({ waitChildren: true });
    const controller = new AbortController();
    const pending = f.start(controller.signal);
    await f.bothChildren;
    if (mode === "signal") controller.abort();
    else await f.db.execute("UPDATE runs SET status='stopped' WHERE parent_run_id IS NULL");
    const parent = await pending;
    expect(parent.status).toBe("stopped");
    expect(f.sent).toHaveLength(3);
    expect(f.writes).toEqual([]);
    expect(await f.db.select("SELECT state FROM code_children ORDER BY ordinal")).toEqual([
      { state: "interrupted" },
      { state: "interrupted" },
    ]);
    expect(
      await f.db.select("SELECT id FROM request_log WHERE billing_state='unknown'"),
    ).toHaveLength(2);
    expect(
      await f.db.select(
        "SELECT id FROM request_reservations WHERE state='unknown' AND bound_micro_usd>0",
      ),
    ).toHaveLength(2);
  },
);

test("child commands require their own approvals despite existing project grants, and never widen lasting authority", async () => {
  const f = await fixture({ commands: true });
  await f.db.execute(
    "INSERT INTO project_commands(workspace_id,user_id,project_id,command,created_at,updated_at) VALUES(?,?,?,?,1,1)",
    [tenant.workspaceId, tenant.userId, f.project.id, "recorded-command"],
  );
  const parent = await f.start();
  expect(parent.status).toBe("done");
  const commands = f.asked.filter((a) => a.kind === "command");
  const network = f.asked.filter((a) => a.kind === "network");
  expect(commands).toHaveLength(2);
  expect(network).toHaveLength(2);
  for (const request of [...commands, ...network]) {
    expect(request.child).toMatchObject({ parentId: parent.id, runId: request.runId });
    expect(f.prepared).toContain(request.runId);
  }
  expect(f.executions).toHaveLength(4);
  expect(f.executions.filter((e) => e.network)).toHaveLength(2);
  for (const execution of f.executions) {
    expect(execution.folder).not.toBe(f.parentFolder);
    expect(execution.sandbox).toEqual([execution.folder]);
  }
  expect(await f.db.select("SELECT command FROM project_commands")).toEqual([
    { command: "recorded-command" },
  ]);
  expect(await f.db.select("SELECT id FROM network_grants")).toEqual([]);
});
