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
