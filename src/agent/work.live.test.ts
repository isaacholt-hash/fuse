// @vitest-environment node
// M8 step 13: the Work benchmark with real models, run by Isaac with his own keys (never in CI):
//   FUSE_ANTHROPIC_API_KEY=… FUSE_OPENAI_API_KEY=… pnpm work:live
// Keys go only in each request's auth header; they're never printed or written anywhere.
// Either key alone runs that provider. FUSE_WORK_ANTHROPIC_MODEL / FUSE_WORK_OPENAI_MODEL pick
// the model (default: the cheapest Balanced one). Each task is a Work run on a fresh copy of
// data/work/fixture; a provider passes with at least 2 of the 3 tasks. A second test has each
// model read a picture from a tool result (data/work/image/gate.png).
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import type { CatalogModel, CloudProviderId } from "@/catalog/catalog";
import { formatUsd } from "@/cost/cost";
import { memoryFilesApi } from "@/files/api";
import type { ProviderAdapter } from "@/providers/types";
import { KEYS, liveAdapter, liveModel } from "./testing/live";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { grantFolder } from "@/storage/folders";
import { listSteps } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { startRun, type ApprovalRequest, type RunDeps } from "./run";
import {
  dropRepo,
  failedChecks,
  freshFolder,
  loadWorkTasks,
  nodeExec,
  nodeRepo,
} from "./testing/bench";

const LIVE = import.meta.env.MODE === "work";
const GATE = 2;
const IMAGE = join(import.meta.dirname, "..", "..", "data", "work", "image", "gate.png");

function modelFor(provider: CloudProviderId): CatalogModel | undefined {
  return liveModel(
    provider,
    provider === "openai"
      ? process.env.FUSE_WORK_OPENAI_MODEL
      : process.env.FUSE_WORK_ANTHROPIC_MODEL,
  );
}

/** One Work run in `dir`, with plans and commands allowed (destructive ones and the network
 * aren't), as if Isaac clicked Allow. */
async function workRun(adapter: ProviderAdapter, model: CatalogModel, dir: string, task: string) {
  const db = openTestDb();
  const t = DEFAULT_TENANT;
  const asked: ApprovalRequest[] = [];
  const deps: RunDeps = {
    db,
    tenant: t,
    catalog: defaultCatalog,
    adapterFor: () => adapter,
    repo: nodeRepo(dir),
    exec: nodeExec(dir),
    // Images a tool reads are kept here and sent with its result, as the app's store does.
    files: memoryFilesApi(),
    approve: (req) => {
      asked.push(req);
      if (req.kind === "network") return Promise.resolve("no" as const);
      return Promise.resolve(!(req.kind === "command" && req.destructive));
    },
  };
  const run = await startRun(deps, {
    projectId: null,
    folders: [await grantFolder(db, t, dir)],
    threadId: null,
    messageId: null,
    task,
    model,
    mode: "auto_edit",
    kind: "work",
  });
  return { run, asked, db, t };
}

const adapterFor = liveAdapter;

test.skipIf(!LIVE)(
  "work benchmark (live, Isaac's keys)",
  async () => {
    const providers = (["anthropic", "openai"] as const).filter((p) => KEYS[p]);
    expect(
      providers.length,
      "set FUSE_OPENAI_API_KEY and/or FUSE_ANTHROPIC_API_KEY",
    ).toBeGreaterThan(0);
    const rows: {
      provider: string;
      task: string;
      pass: boolean;
      status: string;
      turns: number;
      cost: string;
      why: string;
    }[] = [];
    for (const provider of providers) {
      const model = modelFor(provider);
      if (!model) throw new Error(`No ${provider} model found in data/models.json`);
      const adapter = adapterFor(provider);
      for (const task of loadWorkTasks().filter((w) => !w.requires)) {
        const dir = freshFolder();
        try {
          const { run, asked, db, t } = await workRun(adapter, model, dir, task.task);
          const fails = failedChecks(dir, task.checks);
          const plans = asked.filter((a) => a.kind === "organise").length;
          if (task.checks.some((c) => c.kind === "one_organise_plan") && plans !== 1)
            fails.push(`${String(plans)} organise plans, not one`);
          rows.push({
            provider: `${provider}/${model.id}`,
            task: task.id,
            pass: fails.length === 0,
            status: run.status,
            turns: (await listSteps(db, t, run.id)).filter((s) => s.kind === "model").length,
            cost: formatUsd(run.spentMicroUsd),
            why: [run.note, ...fails].filter(Boolean).join("; "),
          });
        } finally {
          dropRepo(dir);
        }
      }
    }
    console.table(rows.map(({ why: _w, ...r }) => r));
    for (const r of rows.filter((x) => !x.pass))
      console.log(`FAILED ${r.provider} ${r.task}: ${r.why}`);
    for (const p of new Set(rows.map((r) => r.provider))) {
      const passed = rows.filter((r) => r.provider === p && r.pass).length;
      const total = rows.filter((r) => r.provider === p).length;
      console.log(
        `${p}: ${String(passed)} of ${String(total)} tasks passed (gate ${String(GATE)})`,
      );
      expect(passed, `${p} passed ${String(passed)} of ${String(total)}`).toBeGreaterThanOrEqual(
        GATE,
      );
    }
  },
  20 * 60 * 1000,
);

// M8 step 4 (WF-03): a picture in a tool result, read by the real APIs. The code in gate.png
// can't be guessed, so writing it down means the model saw the image.
test.skipIf(!LIVE)(
  "images in tool results (live, Isaac's keys)",
  async () => {
    const providers = (["anthropic", "openai"] as const).filter((p) => KEYS[p]);
    expect(
      providers.length,
      "set FUSE_OPENAI_API_KEY and/or FUSE_ANTHROPIC_API_KEY",
    ).toBeGreaterThan(0);
    const rows: {
      provider: string;
      pass: boolean;
      status: string;
      shown: number;
      cost: string;
      why: string;
    }[] = [];
    for (const provider of providers) {
      const model = modelFor(provider);
      if (!model) throw new Error(`No ${provider} model found in data/models.json`);
      const dir = mkdtempSync(join(tmpdir(), "fuse-image-"));
      try {
        cpSync(IMAGE, join(dir, "gate.png"));
        const { run, db, t } = await workRun(
          adapterFor(provider),
          model,
          dir,
          "Look at gate.png. It shows a code. Write exactly that code, and nothing else, into code.txt in the folder's root.",
        );
        const steps = await listSteps(db, t, run.id);
        const shown = steps.filter((s) => s.kind === "tool" && s.images.length > 0).length;
        const tools = steps.flatMap((s) =>
          s.kind === "tool"
            ? [
                s.call.name === "run_command"
                  ? `run_command: ${String(s.call.input.command)}`
                  : s.call.name,
              ]
            : [],
        );
        const fails = failedChecks(dir, [
          { kind: "file_contains", path: "code.txt", text: "HERON-4172" },
        ]);
        if (shown === 0) fails.push("no tool result carried the image");
        rows.push({
          provider: `${provider}/${model.id}`,
          pass: fails.length === 0 && run.status === "done",
          status: run.status,
          shown,
          cost: formatUsd(run.spentMicroUsd),
          why: [run.note, ...fails, `tools: ${tools.join(", ")}`].filter(Boolean).join("; "),
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    console.table(rows.map(({ why: _w, ...r }) => r));
    for (const r of rows) console.log(`${r.pass ? "PASSED" : "FAILED"} ${r.provider}: ${r.why}`);
    for (const r of rows) expect(r.pass, `${r.provider}: ${r.why}`).toBe(true);
  },
  5 * 60 * 1000,
);
