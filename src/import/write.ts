/**
 * Writes chats imported from another app (PL-08): threads, messages with their original dates and
 * branches, and an `imports` row per conversation so running the import again skips it.
 */
import type { Tenant } from "@/storage/defaults";
import { uuidv7 } from "@/storage/ids";
import type { SqlDb } from "@/storage/sql";

export type ImportSource = "chatgpt" | "claude";

export interface ImportedMessage {
  /** The other app's id, used only to link parents. */
  id: string;
  parentId: string | null;
  role: "user" | "assistant";
  content: string;
  /** e.g. "gpt-4o" or "claude-sonnet-4-5" when the export says. */
  model: string | null;
  createdAt: number;
}

export interface ImportedChat {
  externalId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ImportedMessage[];
  /** The message the other app showed last (its current branch); null = the newest. */
  leafId: string | null;
  /** The project it belonged to, by name (Claude). */
  projectName?: string | null;
}

export interface ImportPreview {
  chats: number;
  messages: number;
  /** Already imported before: skipped. */
  already: number;
}

async function alreadyImported(
  db: SqlDb,
  tenant: Tenant,
  source: ImportSource,
): Promise<Set<string>> {
  const rows = await db.select<{ external_id: string }>(
    `SELECT external_id FROM imports WHERE workspace_id = ? AND source = ?`,
    [tenant.workspaceId, source],
  );
  return new Set(rows.map((r) => r.external_id));
}

export async function previewImport(
  db: SqlDb,
  tenant: Tenant,
  source: ImportSource,
  chats: readonly ImportedChat[],
): Promise<ImportPreview> {
  const seen = await alreadyImported(db, tenant, source);
  const fresh = chats.filter((c) => !seen.has(c.externalId));
  return {
    chats: fresh.length,
    messages: fresh.reduce((n, c) => n + c.messages.length, 0),
    already: chats.length - fresh.length,
  };
}

/** Imports the chats not imported before; returns how many chats were written. */
export async function writeImport(
  db: SqlDb,
  tenant: Tenant,
  source: ImportSource,
  chats: readonly ImportedChat[],
  projectIdFor: (name: string) => Promise<string | null> = () => Promise.resolve(null),
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const seen = await alreadyImported(db, tenant, source);
  const todo = chats.filter((c) => !seen.has(c.externalId) && c.messages.length > 0);
  const ws = tenant.workspaceId;
  for (const [n, chat] of todo.entries()) {
    const threadId = uuidv7(chat.createdAt);
    const projectId = chat.projectName ? await projectIdFor(chat.projectName) : null;
    const last = Math.max(chat.updatedAt, ...chat.messages.map((m) => m.createdAt));
    await db.execute(
      `INSERT INTO threads (id, workspace_id, user_id, title, title_source, project_id,
         last_message_at, memory_checked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?)`,
      // memory_checked_at = last: old chats aren't sent for memory suggestions on leaving.
      [
        threadId,
        ws,
        tenant.userId,
        chat.title.slice(0, 200) || "Imported chat",
        projectId,
        last,
        last,
        chat.createdAt,
        last,
      ],
    );
    const ids = new Map<string, string>();
    // Parents before children: by depth in the tree, then by date.
    const byId = new Map(chat.messages.map((m) => [m.id, m]));
    const depth = (m: ImportedMessage) => {
      let d = 0;
      for (let p = m.parentId; p && d < 100_000; p = byId.get(p)?.parentId ?? null) d += 1;
      return d;
    };
    const ordered = chat.messages
      .map((m) => ({ m, d: depth(m) }))
      .sort((a, b) => a.d - b.d || a.m.createdAt - b.m.createdAt)
      .map((x) => x.m);
    for (const m of ordered) {
      const id = uuidv7(m.createdAt);
      ids.set(m.id, id);
      await db.execute(
        `INSERT INTO messages (id, workspace_id, user_id, thread_id, parent_id, role, content,
           status, provider, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?)`,
        [
          id,
          ws,
          tenant.userId,
          threadId,
          m.parentId ? (ids.get(m.parentId) ?? null) : null,
          m.role,
          m.content,
          m.role === "assistant" ? (source === "chatgpt" ? "openai" : "anthropic") : null,
          m.role === "assistant" ? (m.model ?? `${source} (imported)`) : null,
          m.createdAt,
          m.createdAt,
        ],
      );
    }
    const leaf = chat.leafId ? ids.get(chat.leafId) : undefined;
    if (leaf) {
      await db.execute(`UPDATE threads SET active_leaf_id = ? WHERE workspace_id = ? AND id = ?`, [
        leaf,
        ws,
        threadId,
      ]);
    }
    const now = Date.now();
    await db.execute(
      `INSERT INTO imports (id, workspace_id, user_id, source, external_id, thread_id, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv7(now), ws, tenant.userId, source, chat.externalId, threadId, now, now],
    );
    onProgress?.(n + 1, todo.length);
  }
  return todo.length;
}
