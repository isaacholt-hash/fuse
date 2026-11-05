/** Test-only Node owner for real desktop/web click-through; excluded from release builds. */
import { configureHttp } from "@/platform/http";
import { openTauriDb } from "@/storage/tauriDb";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { defaultCatalog as catalog } from "@/catalog/defaultCatalog";
import { setRequestSurface } from "@/storage/requestLog";
import { Runner } from "@/runner/runner";
import type { RepoApi } from "@/repo/api";
import { scriptedResearchWeb } from "./scripted";
import { recordedResearchAdapters } from "./recorded";

const base = process.env.FUSE_SERVER_URL,
  token = process.env.FUSE_RUNNER_TOKEN;
if (
  process.env.FUSE_SERVER_TEST !== "1" ||
  !base ||
  !token ||
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)
)
  throw new Error(
    "Synthetic research requires an isolated loopback server with in-memory test secrets.",
  );
configureHttp({ base, token });
setRequestSurface("runner");
const db = await openTauriDb();
const crash = { requested: false };
const recorded = recordedResearchAdapters({
  delayMs: 700,
  onCall: (call) => {
    if (call.stage === "plan" && call.body.includes("FUSE_RESEARCH_CRASH_FIXTURE"))
      crash.requested = true;
    if (call.stage === "search" && crash.requested) {
      console.log("research-fixture-runner: hard exit after journaled search dispatch");
      process.exit(23);
    }
  },
});
const runner = new Runner({
  deps: () =>
    Promise.resolve({
      db,
      tenant,
      catalog,
      adapterFor: recorded.adapterFor,
      web: scriptedResearchWeb(),
      repo: new Proxy({} as RepoApi, {
        get() {
          throw new Error("Synthetic research cannot touch a repository");
        },
      }),
    }),
});
await runner.recover();
console.log("research-fixture-runner ready; no provider calls");
const state = { stopped: false };
const stop = () => {
  state.stopped = true;
  runner.stopAll();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
while (!state.stopped) {
  await runner.tick();
  await new Promise((resolve) => setTimeout(resolve, 200));
}
await runner.idle();
