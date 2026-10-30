/**
 * Documents in project folders as knowledge (M8 step 11, FK-07): where each was found, what its
 * bytes hashed to, and the file record holding its text. See 0046_folder_files.sql.
 */
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";
import { replaceChunks } from "./vectors";

export interface FolderFile {
  id: string;
  folderId: string;
  path: string;
  fileId: string;
  sha256: string;
  sizeBytes: number;
  modifiedAt: number | null;
}

type Row = {
  id: string;
  folder_id: string;
  path: string;
  file_id: string;
  sha256: string;
  size_bytes: number;
  modified_at: number | null;
};

const toFolderFile = (r: Row): FolderFile => ({
  id: r.id,
  folderId: r.folder_id,
  path: r.path,
  fileId: r.file_id,
  sha256: r.sha256,
  sizeBytes: r.size_bytes,
  modifiedAt: r.modified_at,
});

export async function listFolderFiles(
  db: SqlDb,
  tenant: Tenant,
  folderId: string,
): Promise<FolderFile[]> {
  const rows = await db.select<Row>(
    `SELECT id, folder_id, path, file_id, sha256, size_bytes, modified_at FROM folder_files
     WHERE workspace_id = ? AND folder_id = ? ORDER BY path`,
    [tenant.workspaceId, folderId],
  );
  return rows.map(toFolderFile);
}

/** Every folder document's file id, with its folder: to tell them from uploaded knowledge. */
export async function folderFileOwners(db: SqlDb, tenant: Tenant): Promise<Map<string, string>> {
  const rows = await db.select<{ file_id: string; folder_id: string }>(
    "SELECT file_id, folder_id FROM folder_files WHERE workspace_id = ?",
    [tenant.workspaceId],
  );
  return new Map(rows.map((r) => [r.file_id, r.folder_id]));
}

/** Records a document's current version (its new file record), replacing any earlier one. */
export async function saveFolderFile(
  db: SqlDb,
  tenant: Tenant,
  f: Omit<FolderFile, "id">,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO folder_files (id, workspace_id, user_id, folder_id, path, file_id, sha256,
       size_bytes, modified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, folder_id, path) DO UPDATE SET file_id = excluded.file_id,
       sha256 = excluded.sha256, size_bytes = excluded.size_bytes,
       modified_at = excluded.modified_at, updated_at = excluded.updated_at`,
    [
      uuidv7(now),
      tenant.workspaceId,
      tenant.userId,
      f.folderId,
      f.path,
      f.fileId,
      f.sha256,
      f.sizeBytes,
      f.modifiedAt,
      now,
      now,
    ],
  );
}

/** The same bytes, seen with a new size or time stamp: only those are updated. */
export async function touchFolderFile(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  sizeBytes: number,
  modifiedAt: number | null,
): Promise<void> {
  await db.execute(
    `UPDATE folder_files SET size_bytes = ?, modified_at = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [sizeBytes, modifiedAt, Date.now(), tenant.workspaceId, id],
  );
}

/**
 * A file record a folder document no longer uses (it changed or went away): unlinked from every
 * project and its chunks removed, so nothing searches the old text.
 */
export async function retireFolderFileRecord(
  db: SqlDb,
  tenant: Tenant,
  fileId: string,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `UPDATE project_files SET deleted_at = ?, updated_at = ?
     WHERE workspace_id = ? AND file_id = ? AND deleted_at IS NULL`,
    [now, now, tenant.workspaceId, fileId],
  );
  await replaceChunks(db, tenant, "file", fileId, []);
}

export async function removeFolderFile(db: SqlDb, tenant: Tenant, f: FolderFile): Promise<void> {
  await retireFolderFileRecord(db, tenant, f.fileId);
  await db.execute("DELETE FROM folder_files WHERE workspace_id = ? AND id = ?", [
    tenant.workspaceId,
    f.id,
  ]);
}
