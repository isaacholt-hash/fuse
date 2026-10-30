// @vitest-environment node
// M8 step 13: the Work benchmark with real models, run by Isaac with his own keys (never in CI):
//   FUSE_ANTHROPIC_API_KEY=… FUSE_OPENAI_API_KEY=… pnpm work:live
// Keys go only in each request's auth header; they're never printed or written anywhere.
// Either key alone runs that provider. FUSE_WORK_ANTHROPIC_MODEL / FUSE_WORK_OPENAI_MODEL pick
// the model (default: the cheapest Balanced one). Each task is a Work run on a fresh copy of
// data/work/fixture; a provider passes with at least 2 of the 3 tasks.
import { defaultCatalog } from "@/catalog/defaultCatalog";
import {
  findModel,
  type CatalogModel,
  type CloudProviderId,
  type ProviderId,
} from "@/catalog/catalog";
import { formatUsd } from "@/cost/cost";
import { createAnthropicAdapter } from "@/providers/anthropic/adapter";
import { createOpenAIAdapter } from "@/providers/openai/adapter";
import { SCOPE_HEADER, type FetchLike } from "@/providers/types";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { tierModels } from "@/routing/policy";
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
const KEYS: Record<CloudProviderId, string | undefined> = {
  openai: process.env.FUSE_OPENAI_API_KEY,
  anthropic: process.env.FUSE_ANTHROPIC_API_KEY,
};
const GATE = 2;

/** Real fetch with the key added; FUSE's internal scope header stays here. */
function keyedFetch(provider: ProviderId, key: string): FetchLike {
  return async (url, init) => {
    const { [SCOPE_HEADER]: _scope, ...headers } = init.headers;
    const auth: Record<string, string> =
      provider === "openai" ? { authorization: `Bearer ${key}` } : { "x-api-key": key };
    return fetch(url, {
      method: init.method,
      headers: { ...headers, ...auth },
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  };
}

function modelFor(provider: ProviderId): CatalogModel | undefined {
  const chosen =
    provider === "openai"
      ? process.env.FUSE_WORK_OPENAI_MODEL
      : process.env.FUSE_WORK_ANTHROPIC_MODEL;
  if (chosen) return findModel(defaultCatalog, provider, chosen) ?? undefined;
  return tierModels(defaultPolicy, defaultCatalog, "balanced", { providers: [provider] })[0];
}

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
      const fetch = keyedFetch(provider, KEYS[provider] ?? "");
      const adapter =
        provider === "openai" ? createOpenAIAdapter({ fetch }) : createAnthropicAdapter({ fetch });
      for (const task of loadWorkTasks()) {
        const dir = freshFolder();
        try {
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
            // Plans and commands are allowed (destructive ones and the network aren't), as if
            // Isaac clicked Allow.
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
            task: task.task,
            model,
            mode: "auto_edit",
            kind: "work",
          });
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
