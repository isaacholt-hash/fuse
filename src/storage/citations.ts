import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

/** A web source an answer cites. */
export interface Citation {
  url: string;
  title: string | null;
}

export async function addCitations(
  db: SqlDb,
  tenant: Tenant,
  messageId: string,
  sources: Citation[],
): Promise<void> {
  const now = Date.now();
  for (const [ordinal, s] of sources.entries()) {
    await db.execute(
      `INSERT INTO message_citations (id, workspace_id, user_id, message_id, ordinal, kind, url,
         title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'web', ?, ?, ?, ?)`,
      [
        uuidv7(now),
        tenant.workspaceId,
        tenant.userId,
        messageId,
        ordinal,
        s.url,
        s.title,
        now,
        now,
      ],
    );
  }
}

/** Web sources per message, in first-cited order. */
export async function citationsForMessages(
  db: SqlDb,
  tenant: Tenant,
  messageIds: string[],
): Promise<Map<string, Citation[]>> {
  const out = new Map<string, Citation[]>();
  if (messageIds.length === 0) return out;
  const rows = await db.select<{ message_id: string; url: string; title: string | null }>(
    `SELECT message_id, url, title FROM message_citations
     WHERE workspace_id = ? AND kind = 'web' AND message_id IN (${messageIds.map(() => "?").join(", ")})
     ORDER BY message_id, ordinal`,
    [tenant.workspaceId, ...messageIds],
  );
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    list.push({ url: r.url, title: r.title });
    out.set(r.message_id, list);
  }
  return out;
}

/** A part of an attached file an answer was given (FK-02), e.g. "book.txt, lines 120–140". */
export async function addFileCitations(
  db: SqlDb,
  tenant: Tenant,
  messageId: string,
  sources: { chunkId: string; label: string }[],
): Promise<void> {
  const now = Date.now();
  for (const [ordinal, s] of sources.entries()) {
    await db.execute(
      `INSERT INTO message_citations (id, workspace_id, user_id, message_id, ordinal, kind,
         title, chunk_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'chunk', ?, ?, ?, ?)`,
      [
        uuidv7(now),
        tenant.workspaceId,
        tenant.userId,
        messageId,
        ordinal,
        s.label,
        s.chunkId,
        now,
        now,
      ],
    );
  }
}

/** File excerpts per answer, as labels, in order. */
/** A file or past chat an answer drew on; `chunkId` opens it at that place (FK-10). */
export interface FileSource {
  label: string;
  chunkId: string | null;
}

export async function fileCitationsForMessages(
  db: SqlDb,
  tenant: Tenant,
  messageIds: string[],
): Promise<Map<string, FileSource[]>> {
  const out = new Map<string, FileSource[]>();
  if (messageIds.length === 0) return out;
  const rows = await db.select<{
    message_id: string;
    title: string | null;
    chunk_id: string | null;
  }>(
    `SELECT message_id, title, chunk_id FROM message_citations
     WHERE workspace_id = ? AND kind = 'chunk' AND message_id IN (${messageIds.map(() => "?").join(", ")})
     ORDER BY message_id, ordinal`,
    [tenant.workspaceId, ...messageIds],
  );
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    list.push({ label: r.title ?? "A file", chunkId: r.chunk_id });
    out.set(r.message_id, list);
  }
  return out;
}
