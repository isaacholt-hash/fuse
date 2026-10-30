/**
 * Folders FUSE may work in (M8, WF-02): granted once, then linked to projects (all their chats
 * use them) or to single chats. The path is checked and resolved by Rust when it's granted
 * (`repo_check`), and every file operation is checked against it again in Rust.
 */
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export interface Folder {
  id: string;
  path: string;
  /** CA-01: whether secret-looking files (.env, keys) in it may be read. */
  readSecrets: boolean;
  createdAt: number;
}

interface FolderRow {
  id: string;
  path: string;
  read_sensitive: number;
  created_at: number;
}

const toFolder = (r: FolderRow): Folder => ({
  id: r.id,
  path: r.path,
  readSecrets: r.read_sensitive === 1,
  createdAt: r.created_at,
});

/** The folder's last path segment, for showing it. */
export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Grants a folder (or finds it, by path); `readSecrets` updates an existing grant. */
export async function grantFolder(
  db: SqlDb,
  tenant: Tenant,
  path: string,
  readSecrets = false,
): Promise<Folder> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO folders (id, workspace_id, user_id, path, read_sensitive, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, path)
     DO UPDATE SET read_sensitive = excluded.read_sensitive, updated_at = excluded.updated_at`,
    [uuidv7(now), tenant.workspaceId, tenant.userId, path, readSecrets ? 1 : 0, now, now],
  );
  const rows = await db.select<FolderRow>(
    "SELECT id, path, read_sensitive, created_at FROM folders WHERE workspace_id = ? AND path = ?",
    [tenant.workspaceId, path],
  );
  const row = rows[0];
  if (!row) throw new Error("The folder couldn't be saved.");
  return toFolder(row);
}

const linked = (table: "project_folders" | "thread_folders", key: "project_id" | "thread_id") =>
  `SELECT f.id, f.path, f.read_sensitive, f.created_at FROM ${table} l
   JOIN folders f ON f.id = l.folder_id
   WHERE l.workspace_id = ? AND l.${key} = ? ORDER BY l.created_at, l.id`;

/** A project's folders, in the order they were linked (the first was its M6 repository). */
export async function listProjectFolders(
  db: SqlDb,
  tenant: Tenant,
  projectId: string,
): Promise<Folder[]> {
  const rows = await db.select<FolderRow>(linked("project_folders", "project_id"), [
    tenant.workspaceId,
    projectId,
  ]);
  return rows.map(toFolder);
}

export async function listThreadFolders(
  db: SqlDb,
  tenant: Tenant,
  threadId: string,
): Promise<Folder[]> {
  const rows = await db.select<FolderRow>(linked("thread_folders", "thread_id"), [
    tenant.workspaceId,
    threadId,
  ]);
  return rows.map(toFolder);
}

export async function linkProjectFolder(
  db: SqlDb,
  tenant: Tenant,
  projectId: string,
  folderId: string,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT OR IGNORE INTO project_folders (id, workspace_id, user_id, project_id, folder_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv7(now), tenant.workspaceId, tenant.userId, projectId, folderId, now],
  );
}

export async function unlinkProjectFolder(
  db: SqlDb,
  tenant: Tenant,
  projectId: string,
  folderId: string,
): Promise<void> {
  await db.execute(
    "DELETE FROM project_folders WHERE workspace_id = ? AND project_id = ? AND folder_id = ?",
    [tenant.workspaceId, projectId, folderId],
  );
}

export async function linkThreadFolder(
  db: SqlDb,
  tenant: Tenant,
  threadId: string,
  folderId: string,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT OR IGNORE INTO thread_folders (id, workspace_id, user_id, thread_id, folder_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv7(now), tenant.workspaceId, tenant.userId, threadId, folderId, now],
  );
}

export async function unlinkThreadFolder(
  db: SqlDb,
  tenant: Tenant,
  threadId: string,
  folderId: string,
): Promise<void> {
  await db.execute(
    "DELETE FROM thread_folders WHERE workspace_id = ? AND thread_id = ? AND folder_id = ?",
    [tenant.workspaceId, threadId, folderId],
  );
}
