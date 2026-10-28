/** Full-text search across chats (CH-02), on the messages_fts index (0012_search.sql). */
import type { Tenant } from "./defaults";
import type { SqlDb } from "./sql";

export interface SearchHit {
  threadId: string;
  threadTitle: string;
  /** Null for a match on the chat's title. */
  messageId: string | null;
  role: "user" | "assistant" | null;
  /** The matching text around the hit, with matches between MARK_START and MARK_END. */
  snippet: string;
  createdAt: number;
}

export const MARK_START = "\u0001";
export const MARK_END = "\u0002";

/**
 * The search box's words as an FTS5 query: each word is quoted (so punctuation and FTS syntax
 * can't break it) and matched as a prefix; all words must appear. Null when there are no words.
 */
export function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}_]+/gu);
  if (!words) return null;
  return words.map((w) => `"${w}"*`).join(" ");
}

interface MessageHitRow {
  thread_id: string;
  title: string;
  id: string;
  role: "user" | "assistant";
  snippet: string;
  created_at: number;
}

/** Chat titles first, then messages, best match first. Deleted chats and messages never show. */
export async function searchChats(
  db: SqlDb,
  tenant: Tenant,
  text: string,
  limit = 30,
): Promise<SearchHit[]> {
  const query = ftsQuery(text);
  if (!query) return [];
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const titles = await db.select<{ id: string; title: string; created_at: number }>(
    `SELECT id, title, created_at FROM threads
     WHERE workspace_id = ? AND deleted_at IS NULL AND incognito = 0 AND ${words.map(() => "title LIKE ?").join(" AND ")}
     ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 5`,
    [tenant.workspaceId, ...words.map((w) => `%${w.replace(/[%_\\]/g, "")}%`)],
  );
  const rows = await db.select<MessageHitRow>(
    `SELECT m.thread_id, t.title, m.id, m.role, m.created_at,
            snippet(messages_fts, 0, ?, ?, '…', 14) AS snippet
     FROM messages_fts
     JOIN messages m ON m.rowid = messages_fts.rowid
     JOIN threads t ON t.id = m.thread_id
     WHERE messages_fts MATCH ? AND m.workspace_id = ? AND m.deleted_at IS NULL
       AND t.deleted_at IS NULL AND t.incognito = 0 AND m.role IN ('user', 'assistant')
     ORDER BY rank LIMIT ?`,
    [MARK_START, MARK_END, query, tenant.workspaceId, limit],
  );
  return [
    ...titles.map((t) => ({
      threadId: t.id,
      threadTitle: t.title,
      messageId: null,
      role: null,
      snippet: t.title,
      createdAt: t.created_at,
    })),
    ...rows.map((r) => ({
      threadId: r.thread_id,
      threadTitle: r.title,
      messageId: r.id,
      role: r.role,
      snippet: r.snippet,
      createdAt: r.created_at,
    })),
  ];
}
