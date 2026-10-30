// @vitest-environment node
// M6 step 13, the live half: the coding benchmark against the real OpenAI and Anthropic APIs.
// Skipped in `pnpm test`. Isaac runs it with keys from his own shell, never from a file:
//
//   FUSE_OPENAI_API_KEY=… FUSE_ANTHROPIC_API_KEY=… pnpm coding:live
//
// (or with both already exported; a provider without a key is skipped). Keys go only in the
// request's auth header; they're never printed or written anywhere. Each task runs on a fresh copy
// of data/coding/fixture in a temporary folder, so nothing of yours is touched; commands are
// allowed unless destructive, as if you'd clicked Allow. Models: each provider's cheapest
// Balanced model, or FUSE_CODING_OPENAI_MODEL / FUSE_CODING_ANTHROPIC_MODEL. Cost: a few cents a
// task; each run is capped at $1. Gate: each provider passes at least 2 of the 3 tasks.
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { findModel, type CatalogModel, type ProviderId } from "@/catalog/catalog";
import { formatUsd } from "@/cost/cost";
import { createAnthropicAdapter } from "@/providers/anthropic/adapter";
import { createOpenAIAdapter } from "@/providers/openai/adapter";
import { SCOPE_HEADER, type FetchLike } from "@/providers/types";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { tierModels } from "@/routing/policy";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, setProjectRepo } from "@/storage/projects";
import { listSteps } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { startRun, type RunDeps } from "./run";
import {
  dropRepo,
  failedChecks,
  freshRepo,
  loadTasks,
  nodeExec,
  nodeGit,
  nodeRepo,
} from "./testing/bench";

const LIVE = import.meta.env.MODE === "coding";
const KEYS: Record<ProviderId, string | undefined> = {
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
      ? process.env.FUSE_CODING_OPENAI_MODEL
      : process.env.FUSE_CODING_ANTHROPIC_MODEL;
  if (chosen) return findModel(defaultCatalog, provider, chosen) ?? undefined;
  return tierModels(defaultPolicy, defaultCatalog, "balanced", { providers: [provider] })[0];
}

test.skipIf(!LIVE)(
  "coding benchmark (live, Isaac's keys)",
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
      for (const task of loadTasks()) {
        const dir = freshRepo();
        try {
          const db = openTestDb();
          const t = DEFAULT_TENANT;
          const project = await createProject(db, t, "Tides");
          await setProjectRepo(db, t, project.id, { root: dir, readSecrets: false });
          const deps: RunDeps = {
            db,
            tenant: t,
            catalog: defaultCatalog,
            adapterFor: () => adapter,
            repo: nodeRepo(dir),
            exec: nodeExec(dir),
            git: nodeGit(dir),
            approve: (req) => Promise.resolve(!(req.kind === "command" && req.destructive)),
          };
          const run = await startRun(deps, {
            projectId: project.id,
            threadId: null,
            messageId: null,
            task: task.task,
            model,
            mode: task.mode,
            newBranch: task.newBranch,
          });
          const fails = failedChecks(dir, task.checks);
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
