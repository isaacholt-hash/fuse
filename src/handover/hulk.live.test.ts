// @vitest-environment node
// The M10 live check, run from the Windows test runner (.github/workflows/hulk-live-check.yml).
// This computer stands in for TCHALLA: it pairs with the real FUSE on HULK from a one-time code,
// checks HULK has a key, and hands over a small Code run on this checkout of the repo. Then it
// stops, as if the laptop were closed. The run keeps going on HULK, asks before pushing its
// `fuse/…` branch (Isaac answers that from any browser), and the workflow's second job waits for
// the branch on GitHub. Skipped unless FUSE_HULK_PAIR_CODE is set, so `pnpm test` never runs it.
import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { nodeGit } from "@/agent/testing/bench";
import type { ProviderId } from "@/catalog/catalog";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import type { FilesApi } from "@/files/api";
import type { HulkApi } from "@/handover/api";
import { handOver, handoverState } from "@/handover/handover";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { tierModels } from "@/routing/policy";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { grantFolder, linkProjectFolder } from "@/storage/folders";
import { createProject } from "@/storage/projects";
import { openTestDb } from "@/storage/testing/nodeDb";

const CODE = process.env.FUSE_HULK_PAIR_CODE;
const ADDRESS = (process.env.FUSE_HULK_ADDRESS ?? "https://hulk.tailb7c872.ts.net:4100").replace(
  /\/$/,
  "",
);
const REPO = process.env.FUSE_LIVE_REPO ?? process.cwd();
const t = DEFAULT_TENANT;

async function reply<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const error = data && typeof data === "object" && "error" in data ? data.error : data;
    throw new Error(`HULK said ${String(res.status)}: ${JSON.stringify(error)}`);
  }
  return data as T;
}

const post = (path: string, headers: Record<string, string>, body: string | Uint8Array) =>
  fetch(`${ADDRESS}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : new Uint8Array(body),
  });

/** HULK over HTTP with this run's device token, which is kept in memory and never printed. */
function hulkWith(token: string): HulkApi {
  const bearer = { authorization: `Bearer ${token}` };
  return {
    status: () => Promise.resolve({ address: ADDRESS, paired: true }),
    pair: () => Promise.reject(new Error("already paired")),
    unpair: () => Promise.reject(new Error("revoke this device in HULK's Settings → Devices")),
    invoke: <T>(command: string, args: Record<string, unknown> = {}) =>
      post(
        `/api/invoke/${command}`,
        { ...bearer, "content-type": "application/json" },
        JSON.stringify(args),
      ).then((r) => reply<T>(r)),
    putFile: (bytes) =>
      post(
        "/api/invoke/file_put",
        { ...bearer, "content-type": "application/octet-stream" },
        bytes,
      ).then((r) => reply<{ sha256: string; size: number }>(r)),
  };
}

/** The handover's export is made from a fresh database, so only the throwaway project goes. */
function memoryFiles(): FilesApi {
  const store = new Map<string, Uint8Array>();
  return {
    put: (bytes) => {
      const sha256 = `sha-${String(store.size)}`;
      store.set(sha256, bytes);
      return Promise.resolve({ sha256, size: bytes.length });
    },
    get: (sha) => {
      const b = store.get(sha);
      return b ? Promise.resolve(b) : Promise.reject(new Error(`no file ${sha}`));
    },
  };
}

/** Hands the workflow's next job a value (GitHub Actions' step outputs). */
function output(name: string, value: string) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

describe.skipIf(!CODE)("M10 live check: hand a Code run over to HULK", () => {
  it(
    "pairs, hands over, and leaves once the run is going on its branch",
    async () => {
      // 1. HULK is reachable from here, over the tailnet.
      const state = await fetch(`${ADDRESS}/api/auth/state`)
        .then((r) => reply<{ setUp: boolean; version: string }>(r))
        .catch((e: unknown) => {
          throw new Error(
            `Can't reach ${ADDRESS} from this computer. Is it on the tailnet, and does the ` +
              `tailnet policy allow tcp 4100 to hulk? (${String(e)})`,
          );
        });
      expect(state.setUp).toBe(true);
      console.log(`HULK ${state.version} is reachable at ${ADDRESS}.`);

      // 2. Pair with the one-time code.
      const { token } = await post(
        "/api/auth/pair",
        { "content-type": "application/json" },
        JSON.stringify({ code: CODE, name: `Live check (${hostname()})` }),
      ).then((r) => reply<{ token: string }>(r));
      const hulk = hulkWith(token);
      await hulk.invoke("db_open");

      // 3. HULK has its own key for at least one provider (only whether it's saved is read).
      const providers: ProviderId[] = [];
      for (const p of ["anthropic", "openai"] as const) {
        const s = await hulk.invoke<{ saved: boolean }>("key_status", { provider: p });
        if (s.saved) providers.push(p);
      }
      if (!providers.length)
        throw new Error(
          "HULK has no provider key yet: add one in the web app's Settings → Providers.",
        );
      const model = tierModels(defaultPolicy, defaultCatalog, "balanced", { providers })[0];
      if (!model) throw new Error(`No Balanced model for ${providers.join(", ")}.`);
      console.log(`Keys on HULK: ${providers.join(", ")}. Model: ${model.provider}/${model.id}.`);

      // 4. Hand over a small Code run on this checkout, as the desktop's "Run on HULK" does.
      const desktop = openTestDb();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const project = await createProject(desktop, t, `Live check ${stamp}`);
      const folder = await grantFolder(desktop, t, REPO);
      await linkProjectFolder(desktop, t, project.id, folder.id);
      const requestId = await handOver(
        { db: desktop, tenant: t, files: memoryFiles(), git: nodeGit(REPO), hulk },
        {
          projectId: project.id,
          folderId: folder.id,
          task:
            `Create the file live-check/${stamp}.md containing exactly one line: ` +
            `"Handed over from ${hostname()} at ${stamp}." Change nothing else, ` +
            "and run nothing.",
          model: { provider: model.provider, id: model.id },
          mode: "auto_edit",
          capMicroUsd: 500_000,
        },
      );
      console.log(`Handed over: request ${requestId}.`);
      output("request", requestId);

      // 5. Wait only until the run has its branch, then leave, like a closed laptop.
      const end = Date.now() + 10 * 60_000;
      for (;;) {
        const s = await handoverState(hulk, t, requestId);
        if (s.status === "failed" || s.status === "error" || s.status === "stopped")
          throw new Error(`The run on HULK ${s.status}: ${s.note ?? "no note"}`);
        if (s.branch) {
          console.log(`Going on HULK on ${s.branch} (${s.status}). Leaving now.`);
          output("branch", s.branch);
          return;
        }
        if (Date.now() > end) throw new Error(`No branch after 10 minutes (${s.status}).`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    },
    15 * 60_000,
  );
});
