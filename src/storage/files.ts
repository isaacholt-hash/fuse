import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

/** Attachment metadata (bytes are on disk, see src/files/api.ts). */
export interface FileRecord {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  /** Documents: estimated input tokens (images are estimated per provider from width/height). */
  tokenEstimate: number | null;
  createdAt: number;
}

interface FileRow {
  id: string;
  name: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  token_estimate: number | null;
  created_at: number;
}

const toFile = (r: FileRow): FileRecord => ({
  id: r.id,
  name: r.name,
  mime: r.mime,
  sizeBytes: r.size_bytes,
  sha256: r.sha256,
  width: r.width,
  height: r.height,
  tokenEstimate: r.token_estimate,
  createdAt: r.created_at,
});

export interface NewFile {
  name: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  width?: number | null;
  height?: number | null;
  tokenEstimate?: number | null;
  threadId?: string | null;
}

export async function addFile(db: SqlDb, tenant: Tenant, f: NewFile): Promise<FileRecord> {
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO files (id, workspace_id, user_id, name, mime, size_bytes, sha256, storage_path,
       width, height, token_estimate, thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenant.workspaceId,
      tenant.userId,
      f.name,
      f.mime,
      f.sizeBytes,
      f.sha256,
      `files/${f.sha256}`,
      f.width ?? null,
      f.height ?? null,
      f.tokenEstimate ?? null,
      f.threadId ?? null,
      now,
      now,
    ],
  );
  return {
    id,
    name: f.name,
    mime: f.mime,
    sizeBytes: f.sizeBytes,
    sha256: f.sha256,
    width: f.width ?? null,
    height: f.height ?? null,
    tokenEstimate: f.tokenEstimate ?? null,
    createdAt: now,
  };
}

/** Attaches files to a message, in order. */
export async function linkFiles(
  db: SqlDb,
  tenant: Tenant,
  messageId: string,
  fileIds: string[],
): Promise<void> {
  const now = Date.now();
  for (const [ordinal, fileId] of fileIds.entries()) {
    await db.execute(
      `INSERT INTO message_files (id, workspace_id, user_id, message_id, file_id, ordinal,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv7(now), tenant.workspaceId, tenant.userId, messageId, fileId, ordinal, now, now],
    );
  }
}

/** Files per message, in attachment order. */
export async function filesForMessages(
  db: SqlDb,
  tenant: Tenant,
  messageIds: string[],
): Promise<Map<string, FileRecord[]>> {
  const out = new Map<string, FileRecord[]>();
  if (messageIds.length === 0) return out;
  const rows = await db.select<FileRow & { message_id: string }>(
    `SELECT mf.message_id, f.id, f.name, f.mime, f.size_bytes, f.sha256, f.width, f.height,
            f.token_estimate, f.created_at
     FROM message_files mf JOIN files f ON f.id = mf.file_id
     WHERE mf.workspace_id = ? AND mf.message_id IN (${messageIds.map(() => "?").join(", ")})
       AND f.deleted_at IS NULL
     ORDER BY mf.message_id, mf.ordinal`,
    [tenant.workspaceId, ...messageIds],
  );
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    list.push(toFile(r));
    out.set(r.message_id, list);
  }
  return out;
}
