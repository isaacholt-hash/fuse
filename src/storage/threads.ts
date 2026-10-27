import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export interface Thread {
  id: string;
  title: string;
  titleSource: "user" | "auto";
  lastMessageAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Sum of message costs, in micro-dollars. */
  costMicroUsd: number;
  /** The composer's web search toggle for this thread. */
  webSearch: boolean;
  /** Custom instructions for this thread only (CH-05); empty when none. */
  instructions: string;
}

interface ThreadRow {
  id: string;
  title: string;
  title_source: "user" | "auto";
  last_message_at: number | null;
  created_at: number;
  updated_at: number;
  cost_micro_usd: number;
  web_search: number;
  instructions: string;
}

const toThread = (r: ThreadRow): Thread => ({
  id: r.id,
  title: r.title,
  titleSource: r.title_source,
  lastMessageAt: r.last_message_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  costMicroUsd: r.cost_micro_usd,
  webSearch: r.web_search === 1,
  instructions: r.instructions,
});

const SELECT_THREAD = `
  SELECT t.id, t.title, t.title_source, t.last_message_at, t.created_at, t.updated_at, t.web_search,
         t.instructions,
         COALESCE((SELECT SUM(m.cost_micro_usd) FROM messages m
                   WHERE m.thread_id = t.id AND m.deleted_at IS NULL), 0) AS cost_micro_usd
  FROM threads t`;

export async function createThread(db: SqlDb, tenant: Tenant, title = "New chat"): Promise<Thread> {
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO threads (id, workspace_id, user_id, title, title_source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'auto', ?, ?)`,
    [id, tenant.workspaceId, tenant.userId, title, now, now],
  );
  const thread = await getThread(db, tenant, id);
  if (!thread) throw new Error("Thread insert failed");
  return thread;
}

export async function getThread(db: SqlDb, tenant: Tenant, id: string): Promise<Thread | null> {
  const rows = await db.select<ThreadRow>(
    `${SELECT_THREAD} WHERE t.workspace_id = ? AND t.id = ? AND t.deleted_at IS NULL`,
    [tenant.workspaceId, id],
  );
  const row = rows[0];
  return row ? toThread(row) : null;
}

/** Most recently active first; threads with no messages yet sort by creation time. */
export async function listThreads(db: SqlDb, tenant: Tenant): Promise<Thread[]> {
  const rows = await db.select<ThreadRow>(
    `${SELECT_THREAD} WHERE t.workspace_id = ? AND t.deleted_at IS NULL
     ORDER BY COALESCE(t.last_message_at, t.created_at) DESC, t.id DESC`,
    [tenant.workspaceId],
  );
  return rows.map(toThread);
}

export async function renameThread(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  title: string,
  source: "user" | "auto" = "user",
): Promise<void> {
  await db.execute(
    `UPDATE threads SET title = ?, title_source = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [title, source, Date.now(), tenant.workspaceId, id],
  );
}

export async function setThreadWebSearch(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  on: boolean,
): Promise<void> {
  await db.execute(
    `UPDATE threads SET web_search = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [on ? 1 : 0, Date.now(), tenant.workspaceId, id],
  );
}

export async function setThreadInstructions(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  instructions: string,
): Promise<void> {
  await db.execute(
    `UPDATE threads SET instructions = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [instructions.trim(), Date.now(), tenant.workspaceId, id],
  );
}

export async function deleteThread(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  const now = Date.now();
  await db.execute(
    `UPDATE threads SET deleted_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [now, now, tenant.workspaceId, id],
  );
}
