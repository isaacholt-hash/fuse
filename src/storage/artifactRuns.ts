/**
 * M17.3: owner-local provenance for explicitly approved runs of a Python artifact version.
 * A row is written before the run starts; the native side claims it exactly once.
 */
import { resolveArtifactId } from "@/sync/aliases";
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export interface RunInput {
  name: string;
  sha256: string;
  bytes: number;
}

export interface RunOutputFile {
  path: string;
  sha256: string;
  bytes: number;
}

export type ArtifactRunState =
  "requested" | "running" | "complete" | "failed" | "stopped" | "interrupted";

export interface ArtifactRun {
  id: string;
  artifactId: string;
  versionId: string;
  attempt: number;
  scriptSha256: string;
  inputs: RunInput[];
  state: ArtifactRunState;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  elapsedMs: number | null;
  output: string;
  outputs: RunOutputFile[];
  createdAt: number;
}

/** A run still marked as going after this long has no live process behind it. */
const STALE_MS = 10 * 60 * 1000;
const MAX_OUTPUT = 1_048_576;

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Python code artifacts can be run; everything else can't. */
export const runnable = (a: { type: string; language: string }): boolean =>
  a.type === "code" && ["python", "py", "python3"].includes(a.language.toLowerCase());

/** Records the owner's approval of one attempt: this exact version, source and inputs. */
export async function requestRun(
  db: SqlDb,
  t: Tenant,
  p: { artifactId: string; versionId: string; scriptSha256: string; inputs: RunInput[] },
): Promise<ArtifactRun> {
  const artifactId = await resolveArtifactId(db, t, p.artifactId);
  const names = new Set(p.inputs.map((i) => i.name.toLowerCase()));
  if (p.inputs.length > 16 || names.size !== p.inputs.length)
    throw new Error("Select at most 16 input files with different names.");
  const now = Date.now();
  const id = uuidv7(now);
  const result = await db.batch([
    {
      sql: `INSERT INTO artifact_runs(id,workspace_id,user_id,artifact_id,version_id,attempt,
              script_sha256,inputs,state,created_at,updated_at)
            SELECT ?,?,?,?,?,COALESCE((SELECT MAX(attempt) FROM artifact_runs
              WHERE workspace_id=? AND user_id=? AND version_id=?),0)+1,?,?,'requested',?,?
            WHERE EXISTS(SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id
              WHERE v.id=? AND v.artifact_id=? AND v.workspace_id=? AND a.deleted_at IS NULL)`,
      params: [
        id,
        t.workspaceId,
        t.userId,
        artifactId,
        p.versionId,
        t.workspaceId,
        t.userId,
        p.versionId,
        p.scriptSha256,
        JSON.stringify(p.inputs),
        now,
        now,
        p.versionId,
        artifactId,
        t.workspaceId,
      ],
    },
  ]);
  if (result[0]?.rowsAffected !== 1) throw new Error("That version isn't saved any more.");
  const [run] = (await listRuns(db, t, artifactId)).filter((r) => r.id === id);
  if (!run) throw new Error("Couldn't record the run.");
  return run;
}

/** A run the native side refused before it started (no runtime, no sandbox, changed source). */
export async function refuseRun(db: SqlDb, t: Tenant, id: string, message: string): Promise<void> {
  await db.execute(
    `UPDATE artifact_runs SET state='failed',output=?,updated_at=?
     WHERE workspace_id=? AND user_id=? AND id=? AND state='requested'`,
    [message.slice(0, 4000), Date.now(), t.workspaceId, t.userId, id],
  );
}

/** Saves what the run printed and produced. The native side already set complete/failed. */
export async function finishRun(
  db: SqlDb,
  t: Tenant,
  id: string,
  r: {
    output: string;
    outputs: RunOutputFile[];
    exitCode: number | null;
    timedOut: boolean;
    stopped: boolean;
    truncated: boolean;
    elapsedMs: number;
  },
): Promise<void> {
  await db.execute(
    `UPDATE artifact_runs SET output=?,outputs=?,exit_code=?,timed_out=?,truncated=?,elapsed_ms=?,
       state=CASE WHEN ? THEN 'stopped' WHEN state='running' THEN 'failed' ELSE state END,updated_at=?
     WHERE workspace_id=? AND user_id=? AND id=? AND state IN ('running','complete','failed')`,
    [
      r.output.slice(0, MAX_OUTPUT),
      JSON.stringify(r.outputs),
      r.exitCode,
      r.timedOut ? 1 : 0,
      r.truncated ? 1 : 0,
      r.elapsedMs,
      r.stopped ? 1 : 0,
      Date.now(),
      t.workspaceId,
      t.userId,
      id,
    ],
  );
}

/** Attempts for an artifact, newest first. A run whose process is gone shows as interrupted. */
export async function listRuns(db: SqlDb, t: Tenant, artifactId: string): Promise<ArtifactRun[]> {
  artifactId = await resolveArtifactId(db, t, artifactId);
  await db.execute(
    `UPDATE artifact_runs SET state='interrupted',updated_at=?
     WHERE workspace_id=? AND user_id=? AND artifact_id=? AND state IN ('requested','running')
       AND updated_at<?`,
    [Date.now(), t.workspaceId, t.userId, artifactId, Date.now() - STALE_MS],
  );
  const rows = await db.select<{
    id: string;
    version_id: string;
    attempt: number;
    script_sha256: string;
    inputs: string;
    state: ArtifactRunState;
    exit_code: number | null;
    timed_out: number;
    truncated: number;
    elapsed_ms: number | null;
    output: string;
    outputs: string;
    created_at: number;
  }>(
    `SELECT id,version_id,attempt,script_sha256,inputs,state,exit_code,timed_out,truncated,
            elapsed_ms,output,outputs,created_at
     FROM artifact_runs WHERE workspace_id=? AND user_id=? AND artifact_id=?
     ORDER BY created_at DESC,id DESC LIMIT 50`,
    [t.workspaceId, t.userId, artifactId],
  );
  return rows.map((r) => ({
    id: r.id,
    artifactId,
    versionId: r.version_id,
    attempt: r.attempt,
    scriptSha256: r.script_sha256,
    inputs: JSON.parse(r.inputs) as RunInput[],
    state: r.state,
    exitCode: r.exit_code,
    timedOut: r.timed_out === 1,
    truncated: r.truncated === 1,
    elapsedMs: r.elapsed_ms,
    output: r.output,
    outputs: JSON.parse(r.outputs) as RunOutputFile[],
    createdAt: r.created_at,
  }));
}
