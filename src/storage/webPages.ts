/** Links read for chats (FK-06): the page's text is a stored file, reused for 24 hours. */
import type { Tenant } from "./defaults";
import type { FileRecord } from "./files";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export const PAGE_CACHE_MS = 24 * 3_600_000;

/** The file a link was read into, if it was read in the last 24 hours. */
export async function cachedPage(
  db: SqlDb,
  tenant: Tenant,
  url: string,
  now = Date.now(),
): Promise<FileRecord | null> {
  const rows = await db.select<{
    id: string;
    name: string;
    mime: string;
    size_bytes: number;
    sha256: string;
    token_estimate: number | null;
    created_at: number;
  }>(
    `SELECT f.id, f.name, f.mime, f.size_bytes, f.sha256, f.token_estimate, f.created_at
     FROM web_pages w JOIN files f ON f.id = w.file_id
     WHERE w.workspace_id = ? AND w.url = ? AND w.fetched_at > ? AND f.deleted_at IS NULL
     ORDER BY w.fetched_at DESC LIMIT 1`,
    [tenant.workspaceId, url, now - PAGE_CACHE_MS],
  );
  const r = rows[0];
  return r
    ? {
        id: r.id,
        name: r.name,
        mime: r.mime,
        sizeBytes: r.size_bytes,
        sha256: r.sha256,
        width: null,
        height: null,
        tokenEstimate: r.token_estimate,
        createdAt: r.created_at,
      }
    : null;
}

export async function savePage(
  db: SqlDb,
  tenant: Tenant,
  url: string,
  fileId: string,
  title: string,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO web_pages (id, workspace_id, user_id, url, file_id, title, fetched_at, created_at,
       updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv7(now), tenant.workspaceId, tenant.userId, url, fileId, title, now, now, now],
  );
}
