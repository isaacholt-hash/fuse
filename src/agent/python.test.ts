// @vitest-environment node
// M9 step 6 (AG-03): run_python in Work runs. A fake exec stands in for Rust's sandboxed Python
// (src-tauri/src/exec.rs tests run the real one in bubblewrap).
import { zipSync, strToU8 } from "fflate";
import { importSkill, deleteSkill } from "@/skills/storage";
import { readSkillPackage } from "@/skills/package";
import { setRunStatus } from "@/storage/runs";
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import { memoryFilesApi } from "@/files/api";
import type { ProviderAdapter, StreamEvent, ToolCall, ToolSpec } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import type { ExecApi, PythonResult, SandboxKind } from "@/repo/exec";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, setProjectRepo } from "@/storage/projects";
import { listChanges, listSteps } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import {
  startRun,
  undoChange,
  withoutStartupNoise,
  type ApprovalAnswer,
  type ApprovalRequest,
  type RunDeps,
} from "./run";

const t = DEFAULT_TENANT;
const catalog = parseCatalog({
  price_version: "2026-10-31",
  models: [
    {
      provider: "anthropic",
      id: "test-claude",
      display_name: "Test Claude",
      context_window: 200000,
      max_output: 1000,
      price: { input: 1, output: 1 },
      capabilities: ["tools", "vision"],
      verified_on: "2026-10-31",
      source_url: "https://example.com",
    },
  ],
});
const model = catalog.models[0] as CatalogModel;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const CSV = new TextEncoder().encode("region,total\nnorth,12\nsouth,30\n");

function bytesRepo(
  files: Record<string, Uint8Array>,
): RepoApi & { files: Map<string, Uint8Array> } {
  const fs = new Map(Object.entries(files));
  const unused = () => Promise.reject(new Error("unused"));
  return {
    files: fs,
    pick: () => Promise.resolve(null),
    check: unused,
    list: () => Promise.resolve([]),
    search: () => Promise.resolve([]),
    read: unused,
    write: unused,
    remove: (_f, path) => {
      fs.delete(path);
      return Promise.resolve({ path, before: null });
    },
    move: unused,
    readBytes: (_f, path) => {
      const b = fs.get(path);
      return b ? Promise.resolve(b) : Promise.reject(new Error(`${path}: no such file.`));
    },
    writeBytes: (_f, path, bytes) => {
      fs.set(path, bytes);
      return Promise.resolve(path);
    },
  };
}

function scripted(turns: ToolCall[][]) {
  const tools: ToolSpec[][] = [];
  let n = 0;
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat(_h, m, options): AsyncGenerator<StreamEvent> {
      tools.push(options.tools ?? []);
      const calls = turns[n++] ?? [];
      await Promise.resolve();
      yield { type: "text", text: calls.length ? "Working." : "Done." };
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
        turn: { provider: "anthropic", model: m, items: [] },
      };
    },
  };
  return { adapter, tools };
}

const SCRIPT = "import pandas as pd\nprint(pd.read_csv('sales.csv').total.sum())\n";
const pythonCall: ToolCall = {
  id: "p1",
  name: "run_python",
  input: {
    script: SCRIPT,
    keep: [{ from: "summary.csv", to: "reports/summary.csv" }],
    timeout_seconds: null,
  },
};

async function setup(opts: {
  answer?: ApprovalAnswer;
  ready?: boolean;
  sandbox?: SandboxKind;
  kind?: "work" | "code";
  skill?: boolean;
  keepOutput?: boolean;
  stopDuringScript?: boolean;
  invalidate?: "delete" | "stop";
  mode?: "plan" | "auto_edit";
}) {
  const db = openTestDb();
  const project = await createProject(db, t, "Sales");
  await setProjectRepo(db, t, project.id, { root: "/repo", readSecrets: false });
  const repo = bytesRepo({ "reports/summary.csv": new TextEncoder().encode("old\n") });
  const skillRan: unknown[] = [];
  const imported = opts.skill
    ? await importSkill(db, t, {
        name: "calculate",
        projectId: project.id,
        localOnly: true,
        package: await readSkillPackage(
          "script.zip",
          zipSync({
            "SKILL.md": strToU8("Run when asked."),
            "calculate.py": strToU8("print(42)"),
            "data.txt": strToU8("support"),
          }),
        ),
      })
    : null;
  const ran: { script: string; network: boolean | undefined }[] = [];
  const exec: ExecApi = {
    run: () => Promise.reject(new Error("unused")),
    sandboxKind: () => Promise.resolve(opts.sandbox ?? "bubblewrap"),
    skillPython: async (request) => {
      await Promise.resolve();
      skillRan.push(request);
      if (opts.stopDuringScript) await setRunStatus(db, t, request.runId, "stopped");
      return {
        output: "42\n",
        exitCode: opts.stopDuringScript ? null : 0,
        timedOut: false,
        stopped: opts.stopDuringScript ?? false,
        truncated: false,
        elapsedMs: 1,
        files: [{ path: "result.txt", bytes: CSV }],
        skipped: [],
      };
    },
    python: (_folder, script, o): Promise<PythonResult> => {
      ran.push({ script, network: o.network });
      return Promise.resolve({
        output: "42\n",
        exitCode: 0,
        timedOut: false,
        stopped: false,
        truncated: false,
        elapsedMs: 900,
        files: [
          { path: "chart.png", bytes: PNG },
          { path: "summary.csv", bytes: CSV },
        ],
        skipped: [],
      });
    },
  };
  const skillCall: ToolCall = {
    id: "skill-call",
    name: "run_skill_script",
    input: {
      version_id: imported?.versionId ?? "none",
      path: "calculate.py",
      args: ["literal; $(no shell)"],
      timeout_seconds: 30,
      keep: opts.keepOutput ? [{ from: "result.txt", to: "reports/summary.csv" }] : null,
    },
  };
  const { adapter, tools } = scripted([[opts.skill ? skillCall : pythonCall], []]);
  const asked: ApprovalRequest[] = [];
  const deps: RunDeps = {
    db,
    tenant: t,
    catalog,
    adapterFor: () => adapter,
    repo,
    exec,
    files: memoryFilesApi(),
    pythonReady: () => Promise.resolve(opts.ready ?? true),
    approve: async (req) => {
      asked.push(req);
      if (opts.invalidate === "delete" && imported) await deleteSkill(db, t, imported.skillId);
      if (opts.invalidate === "stop") await setRunStatus(db, t, req.runId, "stopped");
      return opts.answer ?? "yes";
    },
  };
  const r = await startRun(deps, {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: imported
      ? `/skill calculate@${imported.versionId}\nTotal the sales and chart them`
      : "Total the sales and chart them",
    model,
    mode: opts.mode ?? "auto_edit",
    kind: opts.kind ?? "work",
  });
  return { db, deps, repo, ran, asked, tools, r, skillRan, imported };
}

test("run_python asks with the script, runs, shows its chart and saves what it keeps, with undo", async () => {
  const { db, deps, repo, ran, asked, tools, r } = await setup({});
  expect(r.status).toBe("done");
  expect(tools[0]?.map((x) => x.name)).toContain("run_python");
  expect(asked).toEqual([
    expect.objectContaining({
      kind: "python",
      script: SCRIPT,
      keep: ["reports/summary.csv"],
      network: false,
    }),
  ]);
  expect(ran).toEqual([{ script: SCRIPT, network: false }]);

  const step = (await listSteps(db, t, r.id)).find((s) => s.kind === "tool");
  expect(step?.kind === "tool" && step.approval).toBe("you");
  expect(step?.output).toContain("$ python script.py\n42");
  expect(step?.output).toContain("[sandboxed, network off]");
  expect(step?.output).toContain(
    "Files it made in FUSE_OUT: chart.png (1 KB, shown), summary.csv (1 KB)",
  );
  expect(step?.output).toContain("Replaced reports/summary.csv");
  // The chart went to the model as an image.
  expect(step?.kind === "tool" && step.images.map((i) => i.mime)).toEqual(["image/png"]);

  expect(new TextDecoder().decode(repo.files.get("reports/summary.csv"))).toContain("north,12");
  const [change] = await listChanges(db, t, r.id);
  expect(change).toMatchObject({ path: "reports/summary.csv", before: "old\n" });
  expect(change?.after).toContain("south,30");
  await undoChange(deps, change?.id ?? "");
  expect(new TextDecoder().decode(repo.files.get("reports/summary.csv"))).toBe("old\n");
});

test("a declined script doesn't run", async () => {
  const { db, ran, r } = await setup({ answer: "no" });
  expect(ran).toEqual([]);
  expect((await listSteps(db, t, r.id)).find((s) => s.kind === "tool")).toMatchObject({
    isError: true,
    approval: "denied",
  });
});

test("Windows' AppContainer counts as a sandbox for it", async () => {
  const { ran, r } = await setup({ sandbox: "app_container" });
  expect(r.status).toBe("done");
  expect(ran).toHaveLength(1);
});

test("it isn't offered without Python, without the sandbox, or in a Code run, and doesn't run if called", async () => {
  for (const opts of [{ ready: false }, { sandbox: "none" as const }, { kind: "code" as const }]) {
    const { db, tools, ran, asked, r } = await setup(opts);
    expect(tools[0]?.map((x) => x.name)).not.toContain("run_python");
    // The scripted model calls it anyway: refused, not run, nothing asked.
    expect(ran).toEqual([]);
    expect(asked).toEqual([]);
    expect((await listSteps(db, t, r.id)).find((s) => s.kind === "tool")).toMatchObject({
      isError: true,
    });
  }
});

test("F7: Python's own startup line in the Windows sandbox is left out; the script's output isn't", () => {
  const out =
    "Failed to find real location of C:\\Users\\x\\AppData\\Roaming\\com.isaacholt.fuse\\python-runtime\\python\\python.exe\r\ntotal 42\r\n";
  expect(withoutStartupNoise(out)).toBe("total 42\r\n");
  expect(withoutStartupNoise("total 42\nFailed to find real location of x\n")).toBe(
    "total 42\nFailed to find real location of x\n",
  );
});

test("Code skill execution uses the exact approval and native provenance, without generic Python or folder writes", async () => {
  const { asked, tools, skillRan, ran, repo, db, r, imported } = await setup({
    kind: "code",
    skill: true,
  });
  expect(asked).toHaveLength(1);
  const approval = asked[0];
  if (approval?.kind !== "python") throw new Error("Expected Python approval");
  expect(approval.skill?.versionId).toBe(imported?.versionId);
  expect(approval.skill?.assets).toHaveLength(3);
  expect(approval.network).toBe(false);
  expect(approval.keep).toEqual([]);
  expect(approval.script).toBe("print(42)");
  expect(skillRan).toHaveLength(1);
  expect(ran).toHaveLength(0);
  expect(skillRan[0]).toMatchObject({
    runId: r.id,
    callId: "skill-call",
    versionId: imported?.versionId,
    path: "calculate.py",
    args: ["literal; $(no shell)"],
    timeoutSecs: 30,
  });
  expect(tools[0]?.map((t) => t.name)).toContain("run_skill_script");
  expect(tools[0]?.map((t) => t.name)).not.toContain("run_python");
  expect(repo.files.size).toBe(1);
  expect(await listChanges(db, t, r.id)).toHaveLength(0);
  expect((await listSteps(db, t, r.id)).find((s) => s.kind === "tool")?.output).toContain(
    "SHA-256",
  );
});
test.each([
  { answer: "no" as const },
  { ready: false },
  { sandbox: "none" as const },
  { mode: "plan" as const },
  { invalidate: "delete" as const },
  { invalidate: "stop" as const },
])("skill scripts fail closed for approval or execution-state changes %j", async (options) => {
  const { skillRan, ran } = await setup({ kind: "code", skill: true, ...options });
  expect(skillRan).toEqual([]);
  expect(ran).toEqual([]);
});

test("approved skill output uses existing bounded writes and undo, without granting the interpreter folder access", async () => {
  const { db, deps, repo, asked, r } = await setup({ kind: "code", skill: true, keepOutput: true });
  const req = asked[0];
  if (req?.kind !== "python") throw new Error("Expected explicit output approval");
  expect(req.keep).toEqual(["reports/summary.csv"]);
  expect(req.skill?.outputs).toEqual([{ from: "result.txt", to: "reports/summary.csv" }]);
  const changes = await listChanges(db, t, r.id);
  expect(changes).toHaveLength(1);
  expect(repo.files.get("reports/summary.csv")).toEqual(CSV);
  const change = changes[0];
  if (!change) throw new Error("Missing saved output");
  await undoChange(deps, change.id);
  expect(new TextDecoder().decode(repo.files.get("reports/summary.csv"))).toBe("old\n");
});

test("Stop during a skill script does not install even explicitly requested partial outputs", async () => {
  const { db, repo, r } = await setup({
    kind: "code",
    skill: true,
    keepOutput: true,
    stopDuringScript: true,
  });
  expect(r.status).toBe("stopped");
  expect(new TextDecoder().decode(repo.files.get("reports/summary.csv"))).toBe("old\n");
  expect(await listChanges(db, t, r.id)).toHaveLength(0);
});
