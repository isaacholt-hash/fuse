// M10 step 20 (review item 18): what FUSE keeps on this computer, by part, with a clean-up where
// one is safe. Spend totals are never touched: the request log is trimmed only past the usage
// windows, and messages keep their own costs.
import type { Tenant } from "@/storage/defaults";
import type { SqlDb } from "@/storage/sql";
import type { BackupsApi, StorageSizes } from "./backups";

export type StoragePart =
  "database" | "attachments" | "vectors" | "backups" | "requestLog" | "runOutput";

export interface StorageRow {
  id: StoragePart;
  label: string;
  /** Bytes on disk or in the database, where known. */
  bytes: number | null;
  /** Rows or files. */
  count: number;
  /** What the clean-up does; null where none is safe. */
  cleanup: string | null;
}

/** Days of request-log rows kept by the trim: the Usage page looks back two months. */
export const LOG_KEEP_DAYS = 90;
/** Finished runs older than this have their tool output blanked by the trim. */
export const RUN_OUTPUT_KEEP_DAYS = 30;
/** Backups kept by the clean-up: the latest one. */
export const BACKUPS_KEEP = 1;

const DAY_MS = 86_400_000;
/** What replaces a tool step's output once trimmed. */
const REMOVED_OUTPUT = "(output removed to save space)";

const n = async (db: SqlDb, sql: string, params: (string | number)[] = []) =>
  (await db.select<{ n: number | null }>(sql, params))[0]?.n ?? 0;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** The parts and their sizes now. */
export async function storageReport(
  db: SqlDb,
  tenant: Tenant,
  api: Pick<BackupsApi, "sizes">,
): Promise<StorageRow[]> {
  const ws = tenant.workspaceId;
  const sizes: StorageSizes = await api.sizes();
  const messages = await n(db, "SELECT COUNT(*) AS n FROM messages WHERE workspace_id = ?", [ws]);
  const liveFiles = await n(
    db,
    "SELECT COUNT(DISTINCT sha256) AS n FROM files WHERE workspace_id = ? AND deleted_at IS NULL",
    [ws],
  );
  const artifactCount = await n(
    db,
    "SELECT COUNT(*) AS n FROM artifact_vectors WHERE workspace_id = ?",
    [ws],
  );
  const artifactBytes = await n(
    db,
    "SELECT SUM(LENGTH(vector)) AS n FROM artifact_vectors WHERE workspace_id = ?",
    [ws],
  );
  const chunks = await n(db, "SELECT COUNT(*) AS n FROM chunks WHERE workspace_id = ?", [ws]);
  const vectorBytes = await n(
    db,
    "SELECT SUM(LENGTH(vector)) AS n FROM chunk_vectors WHERE workspace_id = ?",
    [ws],
  );
  const chunkBytes = await n(
    db,
    "SELECT SUM(LENGTH(text)) AS n FROM chunks WHERE workspace_id = ?",
    [ws],
  );
  const logRows = await n(db, "SELECT COUNT(*) AS n FROM request_log WHERE workspace_id = ?", [ws]);
  const oldLogRows = await n(
    db,
    "SELECT COUNT(*) AS n FROM request_log WHERE workspace_id = ? AND created_at < ?",
    [ws, Date.now() - LOG_KEEP_DAYS * DAY_MS],
  );
  const steps = await n(db, "SELECT COUNT(*) AS n FROM run_steps WHERE workspace_id = ?", [ws]);
  const stepBytes = await n(
    db,
    `SELECT SUM(COALESCE(LENGTH(text), 0) + COALESCE(LENGTH(output), 0) + COALESCE(LENGTH(input), 0)
       + COALESCE(LENGTH(native), 0)) AS n FROM run_steps WHERE workspace_id = ?`,
    [ws],
  );
  const oldOutput = await n(
    db,
    `SELECT COUNT(*) AS n FROM run_steps WHERE workspace_id = ? AND kind = 'tool'
       AND output IS NOT NULL AND output <> '' AND output <> ?
       AND run_id IN (SELECT id FROM runs WHERE workspace_id = ?
                      AND status IN ('done', 'stopped', 'error') AND updated_at < ?)`,
    [ws, REMOVED_OUTPUT, ws, Date.now() - RUN_OUTPUT_KEEP_DAYS * DAY_MS],
  );
  const stale = sizes.attachmentCount - liveFiles;
  return [
    {
      id: "database",
      label: "Database",
      bytes: sizes.databaseBytes,
      count: messages,
      cleanup: null,
    },
    {
      id: "attachments",
      label: "Attached files",
      bytes: sizes.attachmentBytes,
      count: sizes.attachmentCount,
      cleanup:
        stale > 0
          ? `Remove ${String(stale)} file${stale === 1 ? "" : "s"} no chat or project names any more`
          : null,
    },
    {
      id: "vectors",
      label: "Search index (chunks and embeddings)",
      bytes: vectorBytes + chunkBytes + artifactBytes,
      count: chunks + artifactCount,
      cleanup:
        vectorBytes + artifactBytes > 0
          ? "Clear embeddings (rebuilt when a search needs them)"
          : null,
    },
    {
      id: "backups",
      label: "Backups",
      bytes: sizes.backupBytes,
      count: sizes.backupCount,
      cleanup: sizes.backupCount > BACKUPS_KEEP ? "Keep only the latest backup" : null,
    },
    {
      id: "requestLog",
      label: "Request log",
      bytes: null,
      count: logRows,
      cleanup:
        oldLogRows > 0
          ? `Trim ${String(oldLogRows)} rows older than ${String(LOG_KEEP_DAYS)} days (totals shown in Usage keep adding up)`
          : null,
    },
    {
      id: "runOutput",
      label: "Run output",
      bytes: stepBytes,
      count: steps,
      cleanup:
        oldOutput > 0
          ? `Blank the tool output of ${String(oldOutput)} step${oldOutput === 1 ? "" : "s"} from runs finished more than ${String(RUN_OUTPUT_KEEP_DAYS)} days ago`
          : null,
    },
  ];
}

/** Request-log rows older than the window go; messages and steps keep their own costs. */
export async function trimRequestLog(db: SqlDb, tenant: Tenant, now = Date.now()): Promise<number> {
  const ws = tenant.workspaceId;
  const cutoff = now - LOG_KEEP_DAYS * DAY_MS;
  const old = `SELECT id FROM request_log WHERE workspace_id = ? AND created_at < ?`;
  await db.execute(`UPDATE messages SET request_id = NULL WHERE request_id IN (${old})`, [
    ws,
    cutoff,
  ]);
  await db.execute(`UPDATE run_steps SET request_id = NULL WHERE request_id IN (${old})`, [
    ws,
    cutoff,
  ]);
  const result = await db.execute(
    `DELETE FROM request_log WHERE workspace_id = ? AND created_at < ?`,
    [ws, cutoff],
  );
  return result.rowsAffected;
}

/** Embeddings go; the chunks stay and are embedded again when a search needs them. */
export async function clearVectors(db: SqlDb, tenant: Tenant): Promise<number> {
  const result = await db.batch([
    { sql: "DELETE FROM chunk_vectors WHERE workspace_id = ?", params: [tenant.workspaceId] },
    { sql: "DELETE FROM artifact_vectors WHERE workspace_id = ?", params: [tenant.workspaceId] },
  ]);
  return result.reduce((sum, r) => sum + r.rowsAffected, 0);
}

/** Tool output of runs that ended a while ago is replaced by a note; the steps stay. */
export async function trimRunOutput(db: SqlDb, tenant: Tenant, now = Date.now()): Promise<number> {
  const result = await db.execute(
    `UPDATE run_steps SET output = ?
     WHERE workspace_id = ? AND kind = 'tool' AND output IS NOT NULL AND output <> ''
       AND output <> ?
       AND run_id IN (SELECT id FROM runs WHERE workspace_id = ?
                      AND status IN ('done', 'stopped', 'error') AND updated_at < ?)`,
    [
      REMOVED_OUTPUT,
      tenant.workspaceId,
      REMOVED_OUTPUT,
      tenant.workspaceId,
      now - RUN_OUTPUT_KEEP_DAYS * DAY_MS,
    ],
  );
  return result.rowsAffected;
}

/** Attachment files no live `files` row names any more. */
export async function pruneAttachments(
  db: SqlDb,
  tenant: Tenant,
  api: Pick<BackupsApi, "pruneFiles">,
): Promise<number> {
  const rows = await db.select<{ sha256: string }>(
    `SELECT DISTINCT sha256 FROM files WHERE workspace_id = ? AND deleted_at IS NULL`,
    [tenant.workspaceId],
  );
  return api.pruneFiles(rows.map((r) => r.sha256));
}

/** Runs one part's clean-up and says what it did. */
export async function cleanUp(
  db: SqlDb,
  tenant: Tenant,
  api: Pick<BackupsApi, "pruneFiles" | "pruneBackups">,
  part: StoragePart,
): Promise<string> {
  switch (part) {
    case "attachments": {
      const gone = await pruneAttachments(db, tenant, api);
      return `Removed ${String(gone)} file${gone === 1 ? "" : "s"}.`;
    }
    case "vectors": {
      const gone = await clearVectors(db, tenant);
      return `Cleared ${String(gone)} embedding${gone === 1 ? "" : "s"}.`;
    }
    case "backups": {
      const gone = await api.pruneBackups(BACKUPS_KEEP);
      return `Removed ${String(gone)} backup${gone === 1 ? "" : "s"}.`;
    }
    case "requestLog": {
      const gone = await trimRequestLog(db, tenant);
      return `Trimmed ${String(gone)} request-log row${gone === 1 ? "" : "s"}.`;
    }
    case "runOutput": {
      const gone = await trimRunOutput(db, tenant);
      return `Blanked the output of ${String(gone)} step${gone === 1 ? "" : "s"}.`;
    }
    case "database":
      return "Nothing to clean here.";
  }
}
