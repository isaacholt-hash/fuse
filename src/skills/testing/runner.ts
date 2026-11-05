/** Isolated native-storage/runner fixture. This entry is never included in a release. */
import { configureHttp } from "@/platform/http";
import { openTauriDb } from "@/storage/tauriDb";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { defaultCatalog as catalog } from "@/catalog/defaultCatalog";
import { setRequestSurface } from "@/storage/requestLog";
import { Runner } from "@/runner/runner";
import { tauriRepo } from "@/repo/api";
import { tauriGit } from "@/repo/git";
import { recordedSkillAdapter } from "./scripted";
import { tauriExec } from "@/repo/exec";
import { tauriPythonApi } from "@/python/runtime";
const base = process.env.FUSE_SERVER_URL,
  token = process.env.FUSE_RUNNER_TOKEN;
if (
  process.env.FUSE_SERVER_TEST !== "1" ||
  !base ||
  !token ||
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)
)
  throw new Error(
    "Synthetic skill requires an isolated loopback server with in-memory test secrets.",
  );
configureHttp({ base, token });
setRequestSurface("runner");
const db = await openTauriDb();
const runner = new Runner({
  deps: () =>
    Promise.resolve({
      db,
      tenant,
      catalog,
      repo: tauriRepo,
      git: tauriGit,
      exec: tauriExec,
      pythonReady: () => tauriPythonApi.status().then((r) => r !== null),
      adapterFor: (provider) => recordedSkillAdapter(provider),
    }),
});
await runner.recover();
console.log("skill-script-fixture-runner ready; no provider calls");
const state = { stopped: false };
const stop = () => {
  state.stopped = true;
  runner.stopAll();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
while (!state.stopped) {
  await runner.tick();
  await new Promise((r) => setTimeout(r, 200));
}
await runner.idle();
