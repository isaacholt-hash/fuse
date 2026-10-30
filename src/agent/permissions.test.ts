// @vitest-environment node
// M6 step 8: permission modes, always-allow and destructive commands (CA-04, AG-04).
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import type { ProviderAdapter, StreamEvent, ToolCall } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import type { ExecApi } from "@/repo/exec";
import { DEFAULT_TENANT } from "@/storage/defaults";
import {
  allowCommand,
  createProject,
  listAllowedCommands,
  setProjectRepo,
} from "@/storage/projects";
import { listChanges, listSteps, recentToolCalls } from "@/storage/runs";
import { auditRow } from "@/app/runView";
import { openTestDb } from "@/storage/testing/nodeDb";
import { startRun, type ApprovalAnswer, type ApprovalRequest, type RunDeps } from "./run";

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

function memoryRepo(files: Record<string, string>): RepoApi & { files: Map<string, string> } {
  const fs = new Map(Object.entries(files));
  return {
    files: fs,
    pick: () => Promise.resolve(null),
    check: () => Promise.reject(new Error("unused")),
    list: () => Promise.resolve([]),
    search: () => Promise.resolve([]),
    read: (_p, path) => {
      const content = fs.get(path);
      return content === undefined
        ? Promise.reject(new Error(`${path}: no such file.`))
        : Promise.resolve({
            path,
            content,
            offset: 0,
            totalBytes: content.length,
            truncated: false,
          });
    },
    write: (_p, path, content) => {
      const before = fs.get(path) ?? null;
      fs.set(path, content);
      return Promise.resolve({ path, before });
    },
    remove: () => Promise.reject(new Error("unused")),
    move: () => Promise.reject(new Error("unused")),
  };
}

async function setup(
  calls: ToolCall[],
  answer: (r: ApprovalRequest) => ApprovalAnswer,
  mode: "ask" | "auto_edit",
) {
  const db = openTestDb();
  const project = await createProject(db, t, "Lighthouse");
  await setProjectRepo(db, t, project.id, { root: "/repo", readSecrets: false });
  const repo = memoryRepo({ "a.ts": "const a = 1;\n" });
  const ran: string[] = [];
  const exec: ExecApi = {
    run: (_p, command) => {
      ran.push(command);
      return Promise.resolve({
        output: "",
        exitCode: 0,
        timedOut: false,
        stopped: false,
        truncated: false,
        elapsedMs: 1,
      });
    },
  };
  const asked: ApprovalRequest[] = [];
  const go = async () => {
    let n = 0;
    const adapter: ProviderAdapter = {
      provider: "anthropic",
      listModels: () => Promise.resolve([]),
      async *streamChat(_h, m): AsyncGenerator<StreamEvent> {
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
      exec,
      approve: (r) => {
        asked.push(r);
        return Promise.resolve(answer(r));
      },
    };
    return startRun(deps, {
      projectId: project.id,
      threadId: null,
      messageId: null,
      task: "Go",
      model,
      mode,
    });
  };
  return { db, project, repo, ran, asked, go };
}

const edit: ToolCall = {
  id: "e1",
  name: "edit_file",
  input: { path: "a.ts", old_text: "= 1", new_text: "= 2" },
};
const cmd = (command: string, id = "c1"): ToolCall => ({
  id,
  name: "run_command",
  input: { command, timeout_seconds: null },
});

test("Ask: an edit shows its diff first; declined, the file stays as it was", async () => {
  const { db, repo, asked, go } = await setup([edit], () => "no", "ask");
  const r = await go();
  expect(asked).toEqual([
    {
      runId: r.id,
      kind: "edit",
      change: { path: "a.ts", fromPath: null, before: "const a = 1;\n", after: "const a = 2;\n" },
    },
  ]);
  expect(repo.files.get("a.ts")).toBe("const a = 1;\n");
  const step = (await listSteps(db, t, r.id)).find((s) => s.kind === "tool");
  expect(step).toMatchObject({ approval: "denied", isError: true });
  expect(await listChanges(db, t, r.id)).toEqual([]);
});

test("Ask: allowed, the edit happens and is recorded as yours", async () => {
  const { db, repo, go } = await setup([edit], () => "yes", "ask");
  const r = await go();
  expect(repo.files.get("a.ts")).toBe("const a = 2;\n");
  expect((await listSteps(db, t, r.id)).find((s) => s.kind === "tool")).toMatchObject({
    approval: "you",
    isError: false,
  });
  expect(await listChanges(db, t, r.id)).toHaveLength(1);
});

test("Auto-edit: edits go ahead without asking; commands still ask", async () => {
  const { db, asked, ran, go } = await setup([edit, cmd("pnpm test")], () => "yes", "auto_edit");
  const r = await go();
  expect(asked.map((a) => a.kind)).toEqual(["command"]);
  expect(ran).toEqual(["pnpm test"]);
  const approvals = (await listSteps(db, t, r.id)).flatMap((s) =>
    s.kind === "tool" ? [s.approval] : [],
  );
  expect(approvals).toEqual(["auto", "you"]);
});

test("Always allow: the next time that exact command runs without asking", async () => {
  const { db, project, asked, ran, go } = await setup(
    [cmd("pnpm test")],
    () => "always",
    "auto_edit",
  );
  await go();
  expect(await listAllowedCommands(db, t, project.id)).toEqual(["pnpm test"]);
  const second = await go();
  expect(asked).toHaveLength(1);
  expect(ran).toEqual(["pnpm test", "pnpm test"]);
  expect((await listSteps(db, t, second.id)).find((s) => s.kind === "tool")).toMatchObject({
    approval: "always",
  });
});

test("destructive commands ask every time, even when always-allowed, and can't be always-allowed", async () => {
  const { db, project, asked, ran, go } = await setup(
    [cmd("git push --force")],
    () => "always",
    "auto_edit",
  );
  await allowCommand(db, t, project.id, "git push --force");
  await go();
  expect(asked).toEqual([
    expect.objectContaining({
      kind: "command",
      command: "git push --force",
      destructive: "force-pushes",
    }),
  ]);
  expect(ran).toEqual(["git push --force"]);
  // "always" on a destructive command doesn't add it (it was already there from the test setup).
  expect((await listAllowedCommands(db, t, project.id)).filter((c) => c.startsWith("git"))).toEqual(
    ["git push --force"],
  );
});

test("the audit log lists every tool call with how it was allowed, newest first", async () => {
  const { db, go } = await setup([edit, cmd("pnpm test")], () => "yes", "ask");
  await go();
  const rows = (await recentToolCalls(db, t)).map(auditRow);
  expect(rows.map((r) => [r.action, r.allowed, r.project])).toEqual([
    ["Ran pnpm test", "you", "Lighthouse"],
    ["Edited a.ts", "you", "Lighthouse"],
  ]);
  expect(rows[0]?.model).toBe("anthropic/test-claude");
});
