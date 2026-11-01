// The runner's entry point (M10 step 6). fuse-server starts it with Node and gives it the
// server's address and a device token of its own; everything else (the database, provider
// requests, folders, commands, git, MCP) goes through the server's commands, as the web app's
// do. Built by `pnpm build:runner` into one file, dist-runner/runner.mjs.
import type { ProviderId } from "@/catalog/catalog";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import type { RunDeps } from "@/agent/run";
import { housekeepingModel } from "@/chat/housekeeping";
import { tauriFilesApi } from "@/files/api";
import { tauriKeysApi } from "@/keys/api";
import { tauriMcpApi } from "@/mcp/api";
import { configureHttp } from "@/platform/http";
import { setRequestSurface } from "@/storage/requestLog";
import { createAnthropicAdapter } from "@/providers/anthropic/adapter";
import { createOpenAIAdapter } from "@/providers/openai/adapter";
import type { ProviderAdapter } from "@/providers/types";
import { tauriPythonApi } from "@/python/runtime";
import { tauriRepo } from "@/repo/api";
import { tauriExec } from "@/repo/exec";
import { tauriGit } from "@/repo/git";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { listProjectMcpServers } from "@/storage/mcp";
import { openTauriDb } from "@/storage/tauriDb";
import { providerFetch } from "@/transport/tauriFetch";
import { tauriWebApi } from "@/web/api";
import { Runner } from "./runner";

const base = process.env.FUSE_SERVER_URL;
const token = process.env.FUSE_RUNNER_TOKEN;
if (!base || !token) {
  console.error(
    "runner: FUSE_SERVER_URL and FUSE_RUNNER_TOKEN must be set (fuse-server sets them).",
  );
  process.exit(2);
}
configureHttp({ base, token });
// M10 step 17: Usage counts the runner's requests (and scheduled tasks') apart.
setRequestSurface("runner");

// Keys stay on the server: provider requests go through its transport, which adds them.
const adapters: Partial<Record<ProviderId, ProviderAdapter>> = {
  anthropic: createAnthropicAdapter({ fetch: providerFetch("anthropic") }),
  openai: createOpenAIAdapter({ fetch: providerFetch("openai") }),
};
const adapterFor = (p: ProviderId): ProviderAdapter => {
  const a = adapters[p];
  if (!a) throw new Error(`The ${p} provider isn't available on the server.`);
  return a;
};

const db = await openTauriDb();
const tenant = DEFAULT_TENANT;

/** The providers that have a key now; checked for each run, since keys can be added any time. */
async function keyed(): Promise<ProviderId[]> {
  const all = ["anthropic", "openai"] as const;
  const saved = await Promise.all(all.map((p) => tauriKeysApi.status(p).then((s) => s.saved)));
  return all.filter((_, i) => saved[i]);
}

async function deps(): Promise<RunDeps> {
  const summarizer = housekeepingModel(defaultPolicy, defaultCatalog, "summary", await keyed());
  const mcp = tauriMcpApi;
  return {
    db,
    tenant,
    catalog: defaultCatalog,
    adapterFor,
    files: tauriFilesApi,
    repo: tauriRepo,
    exec: tauriExec,
    git: tauriGit,
    web: tauriWebApi,
    pythonReady: () => tauriPythonApi.status().then((r) => r !== null),
    ...(summarizer ? { summarizer } : {}),
    ...(mcp.tools && mcp.call
      ? {
          mcp: {
            forProject: (pid: string) =>
              listProjectMcpServers(db, tenant, pid).then((l) =>
                l.map((s) => ({ id: s.id, name: s.name })),
              ),
            tools: (id: string) => mcp.tools?.(id) ?? Promise.resolve([]),
            call: (id: string, name: string, args: Record<string, unknown>) =>
              mcp.call
                ? mcp.call(id, name, args)
                : Promise.reject(new Error("MCP calls aren't available here.")),
          },
        }
      : {}),
  };
}

const log = (line: string) => {
  console.log(`runner: ${line}`);
};
const runner = new Runner({ deps, log });
await runner.recover();
log("ready");

const state = { stopping: false };
const stop = () => {
  state.stopping = true;
  runner.stopAll();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

while (!state.stopping) {
  await runner.tick().catch((e: unknown) => {
    log(`couldn't read requests: ${e instanceof Error ? e.message : String(e)}`);
  });
  await new Promise((r) => setTimeout(r, 1000));
}
// Stopped runs are saved as stopped, to be continued.
await runner.idle();
log("stopped");
