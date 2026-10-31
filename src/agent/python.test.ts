// @vitest-environment node
// M9 step 6 (AG-03): run_python in Work runs. A fake exec stands in for Rust's sandboxed Python
// (src-tauri/src/exec.rs tests run the real one in bubblewrap).
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
}) {
  const db = openTestDb();
  const project = await createProject(db, t, "Sales");
  await setProjectRepo(db, t, project.id, { root: "/repo", readSecrets: false });
  const repo = bytesRepo({ "reports/summary.csv": new TextEncoder().encode("old\n") });
  const ran: { script: string; network: boolean | undefined }[] = [];
  const exec: ExecApi = {
    run: () => Promise.reject(new Error("unused")),
    sandboxKind: () => Promise.resolve(opts.sandbox ?? "bubblewrap"),
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
  const { adapter, tools } = scripted([[pythonCall], []]);
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
    approve: (req) => {
      asked.push(req);
      return Promise.resolve(opts.answer ?? "yes");
    },
  };
  const r = await startRun(deps, {
    projectId: project.id,
    threadId: null,
    messageId: null,
    task: "Total the sales and chart them",
    model,
    mode: "auto_edit",
    kind: opts.kind ?? "work",
  });
  return { db, deps, repo, ran, asked, tools, r };
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
