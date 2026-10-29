/** Project knowledge (PM-09): files every chat in a project can draw on. */
import type { Tenant } from "./defaults";
import type { FileRecord } from "./files";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export interface ProjectFile extends FileRecord {
  /** Chunks made from the file, and how many have a vector: the index status. */
  chunks: number;
  embedded: number;
  /** SE-13: false keeps it on this device: never sent or embedded. */
  maySend: boolean;
}

export async function listProjectFiles(
  db: SqlDb,
  tenant: Tenant,
  projectId: string,
): Promise<ProjectFile[]> {
  const rows = await db.select<{
    id: string;
    name: string;
    mime: string;
    size_bytes: number;
    sha256: string;
    width: number | null;
    height: number | null;
    token_estimate: number | null;
    created_at: number;
    chunks: number;
    embedded: number;
    may_send: number;
  }>(
    `SELECT f.id, f.name, f.mime, f.size_bytes, f.sha256, f.width, f.height, f.token_estimate,
            f.created_at, f.may_send,
            (SELECT COUNT(*) FROM chunks c
              WHERE c.workspace_id = pf.workspace_id AND c.source_kind = 'file' AND c.source_id = f.id)
              AS chunks,
            (SELECT COUNT(DISTINCT v.chunk_id) FROM chunks c JOIN chunk_vectors v ON v.chunk_id = c.id
              WHERE c.workspace_id = pf.workspace_id AND c.source_kind = 'file' AND c.source_id = f.id)
              AS embedded
     FROM project_files pf JOIN files f ON f.id = pf.file_id
     WHERE pf.workspace_id = ? AND pf.project_id = ? AND pf.deleted_at IS NULL
     ORDER BY pf.created_at`,
    [tenant.workspaceId, projectId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
    width: r.width,
    height: r.height,
    tokenEstimate: r.token_estimate,
    createdAt: r.created_at,
    mode: "retrieval",
    chunks: r.chunks,
    embedded: r.embedded,
    maySend: r.may_send === 1,
  }));
}

export async function addProjectFile(
  db: SqlDb,
  tenant: Tenant,
  projectId: string,
  fileId: string,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO project_files (id, workspace_id, user_id, project_id, file_id, created_at,
       updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuidv7(now), tenant.workspaceId, tenant.userId, projectId, fileId, now, now],
  );
}

export async function removeProjectFile(
  db: SqlDb,
  tenant: Tenant,
  projectId: string,
  fileId: string,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `UPDATE project_files SET deleted_at = ?, updated_at = ?
     WHERE workspace_id = ? AND project_id = ? AND file_id = ? AND deleted_at IS NULL`,
    [now, now, tenant.workspaceId, projectId, fileId],
  );
}
