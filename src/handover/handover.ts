// Handing a Code run over to HULK (M10 step 7, CA-15): the desktop sends the project (as its
// PL-12 export), the repository's remote and branch, and the task. The server's runner restores
// the project, works in its own clone on a `fuse/…` branch, and asks before pushing it, so the
// run keeps going with this computer closed. The desktop keeps the request's id to show how it's
// going.
import { exportData } from "@/data/exportAll";
import type { FilesApi } from "@/files/api";
import type { GitApi } from "@/repo/git";
import type { Tenant } from "@/storage/defaults";
import { askToStart, getRequest, type ModelRef } from "@/storage/runQueue";
import type { RunMode, RunStatus } from "@/storage/runs";
import type { SqlDb } from "@/storage/sql";
import { hulkDb, type HulkApi } from "./api";

export interface HandoverDeps {
  db: SqlDb;
  tenant: Tenant;
  files: FilesApi;
  git: GitApi;
  hulk: HulkApi;
}

export interface HandoverInput {
  projectId: string;
  /** The project's repository folder here, for its remote and branch. */
  folderId: string;
  task: string;
  model: ModelRef;
  planner?: ModelRef | null;
  mode: RunMode;
  capMicroUsd?: number;
}

/**
 * Where HULK should start from: the `origin` remote and the branch checked out here. Refused
 * while this computer has work HULK can't see (changes not committed, or commits not pushed),
 * since HULK works from what's on the remote.
 */
export async function repoOrigin(
  git: GitApi,
  folderId: string,
): Promise<{ remote: string; branch: string }> {
  const out = async (args: string[]) => {
    const r = await git.run(folderId, "git", args);
    if (r.exitCode !== 0) throw new Error(r.output.trim() || `git ${args.join(" ")} failed`);
    return r.output.trim();
  };
  const remote = await out(["remote", "get-url", "origin"]).catch(() => {
    throw new Error("This repository has no origin remote, so HULK can't get it.");
  });
  const branch = await out(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") throw new Error("Check out a branch first: HULK starts from a branch.");
  if (await out(["status", "--porcelain"]))
    throw new Error("Commit or stash your changes first: HULK works from what's pushed.");
  const ahead = await out(["rev-list", "--count", `origin/${branch}..HEAD`]).catch(() => {
    throw new Error(`Push ${branch} first: it isn't on origin yet.`);
  });
  if (ahead !== "0") throw new Error(`Push ${branch} first: HULK works from what's on origin.`);
  return { remote, branch };
}

/** Sends the run to HULK; returns the request's id there. */
export async function handOver(deps: HandoverDeps, input: HandoverInput): Promise<string> {
  const { remote, branch } = await repoOrigin(deps.git, input.folderId);
  const { bytes } = await exportData(deps.db, deps.tenant, deps.files, {
    kind: "project",
    projectId: input.projectId,
  });
  const stored = await deps.hulk.putFile(bytes);
  await deps.hulk.invoke("db_open");
  return askToStart(hulkDb(deps.hulk), deps.tenant, {
    threadId: null,
    projectId: input.projectId,
    task: input.task,
    model: input.model,
    planner: input.planner ?? null,
    mode: input.mode,
    kind: "code",
    newBranch: true,
    ...(input.capMicroUsd !== undefined ? { capMicroUsd: input.capMicroUsd } : {}),
    handover: { exportSha: stored.sha256, remote, branch },
  });
}

export interface HandoverState {
  /** "queued" until HULK's runner takes it; then the run's own status. */
  status: "queued" | "failed" | RunStatus;
  note: string | null;
  branch: string | null;
}

/** How a handed-over run is going, read from HULK. */
export async function handoverState(
  hulk: HulkApi,
  tenant: Tenant,
  requestId: string,
): Promise<HandoverState> {
  const db = hulkDb(hulk);
  const req = await getRequest(db, tenant, requestId);
  if (!req) return { status: "failed", note: "HULK doesn't have this request.", branch: null };
  if (req.status === "failed") return { status: "failed", note: req.error, branch: null };
  if (!req.runId) return { status: "queued", note: null, branch: null };
  const rows = await db.select<{ status: RunStatus; note: string | null; branch: string | null }>(
    "SELECT status, note, branch FROM runs WHERE workspace_id = ? AND id = ?",
    [tenant.workspaceId, req.runId],
  );
  const run = rows[0];
  return run ? { ...run } : { status: "queued", note: null, branch: null };
}
