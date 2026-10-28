import type { ProviderId } from "@/catalog/catalog";
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
  /** The project this thread belongs to, or null. */
  projectId: string | null;
  /** Saved memories are sent with this chat's messages (PM-04). */
  memoryOn: boolean;
  /** The last_message_at the memory check last covered; null if never checked. */
  memoryCheckedAt: number | null;
  /** RT-01 pins: a tier, or a model (provider + id); all null means Auto. */
  pinnedTier: "balanced" | "best" | null;
  pinnedProvider: ProviderId | null;
  pinnedModel: string | null;
  /** The message the thread shows the path to (CH-04); null = the newest leaf. */
  activeLeafId: string | null;
  /** Incognito (CH-15): not listed or searched, no memory, purged when you leave it. */
  incognito: boolean;
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
  project_id: string | null;
  memory_injection: "on" | "off";
  memory_checked_at: number | null;
  pinned_tier: "balanced" | "best" | null;
  pinned_provider: string | null;
  pinned_model: string | null;
  active_leaf_id: string | null;
  incognito: number;
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
  projectId: r.project_id,
  memoryOn: r.memory_injection === "on",
  memoryCheckedAt: r.memory_checked_at,
  pinnedTier: r.pinned_tier,
  pinnedProvider:
    r.pinned_provider === "openai" || r.pinned_provider === "anthropic" ? r.pinned_provider : null,
  pinnedModel: r.pinned_model,
  activeLeafId: r.active_leaf_id,
  incognito: r.incognito === 1,
});

const SELECT_THREAD = `
  SELECT t.id, t.title, t.title_source, t.last_message_at, t.created_at, t.updated_at, t.web_search,
         t.instructions, t.project_id, t.memory_injection, t.memory_checked_at,
         t.pinned_tier, t.pinned_provider, t.pinned_model, t.active_leaf_id, t.incognito,
         COALESCE((SELECT SUM(m.cost_micro_usd) FROM messages m
                   WHERE m.thread_id = t.id AND m.deleted_at IS NULL), 0) AS cost_micro_usd
  FROM threads t`;

export async function createThread(
  db: SqlDb,
  tenant: Tenant,
  title = "New chat",
  projectId: string | null = null,
  incognito = false,
): Promise<Thread> {
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO threads
       (id, workspace_id, user_id, title, title_source, project_id, incognito, memory_injection,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 'auto', ?, ?, ?, ?, ?)`,
    [
      id,
      tenant.workspaceId,
      tenant.userId,
      title,
      projectId,
      incognito ? 1 : 0,
      incognito ? "off" : "on",
      now,
      now,
    ],
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

/** Moves a thread into a project, or out of any project with null. */
export async function setThreadProject(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  projectId: string | null,
): Promise<void> {
  await db.execute(
    `UPDATE threads SET project_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [projectId, Date.now(), tenant.workspaceId, id],
  );
}

export async function setThreadMemory(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  on: boolean,
): Promise<void> {
  await db.execute(
    `UPDATE threads SET memory_injection = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [on ? "on" : "off", Date.now(), tenant.workspaceId, id],
  );
}

/** Shows the path to this message (a branch switch, or the newest answer). */
export async function setActiveLeaf(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  leafId: string | null,
): Promise<void> {
  await db.execute(`UPDATE threads SET active_leaf_id = ? WHERE workspace_id = ? AND id = ?`, [
    leafId,
    tenant.workspaceId,
    id,
  ]);
}

/** Pins the thread to a tier or a model (RT-01); nulls put it back on Auto. */
export async function setThreadPins(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  pins: {
    tier: "balanced" | "best" | null;
    model: { provider: ProviderId; id: string } | null;
  },
): Promise<void> {
  await db.execute(
    `UPDATE threads SET pinned_tier = ?, pinned_provider = ?, pinned_model = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [
      pins.model ? null : pins.tier,
      pins.model?.provider ?? null,
      pins.model?.id ?? null,
      Date.now(),
      tenant.workspaceId,
      id,
    ],
  );
}

/** Records that the thread's messages up to `lastMessageAt` were checked for memories. */
export async function markMemoryChecked(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  lastMessageAt: number,
): Promise<void> {
  await db.execute(`UPDATE threads SET memory_checked_at = ? WHERE workspace_id = ? AND id = ?`, [
    lastMessageAt,
    tenant.workspaceId,
    id,
  ]);
}

export async function deleteThread(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  const now = Date.now();
  await db.execute(
    `UPDATE threads SET deleted_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [now, now, tenant.workspaceId, id],
  );
}

/**
 * Removes an incognito chat for good (CH-15): its messages, their files links, citations and
 * memory links, and the chat itself. Request-log rows stay for cost totals, unlinked (they hold
 * no text). Safe to run again if it was interrupted.
 */
export async function purgeThread(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  const ws = tenant.workspaceId;
  const inThread = `SELECT id FROM messages WHERE workspace_id = ? AND thread_id = ?`;
  for (const table of ["message_files", "message_citations", "message_memories"]) {
    await db.execute(`DELETE FROM ${table} WHERE message_id IN (${inThread})`, [ws, id]);
  }
  await db.execute(
    `UPDATE request_log SET thread_id = NULL, message_id = NULL WHERE workspace_id = ? AND thread_id = ?`,
    [ws, id],
  );
  await db.execute(`UPDATE threads SET active_leaf_id = NULL WHERE workspace_id = ? AND id = ?`, [
    ws,
    id,
  ]);
  await db.execute(
    `DELETE FROM artifact_versions WHERE workspace_id = ? AND artifact_id IN
       (SELECT id FROM artifacts WHERE workspace_id = ? AND thread_id = ?)`,
    [ws, ws, id],
  );
  await db.execute(`DELETE FROM artifacts WHERE workspace_id = ? AND thread_id = ?`, [ws, id]);
  await db.execute(`DELETE FROM thread_summaries WHERE workspace_id = ? AND thread_id = ?`, [
    ws,
    id,
  ]);
  await db.execute(`DELETE FROM messages WHERE workspace_id = ? AND thread_id = ?`, [ws, id]);
  await db.execute(`UPDATE files SET thread_id = NULL WHERE workspace_id = ? AND thread_id = ?`, [
    ws,
    id,
  ]);
  await db.execute(`DELETE FROM imports WHERE workspace_id = ? AND thread_id = ?`, [ws, id]);
  await db.execute(`DELETE FROM threads WHERE workspace_id = ? AND id = ?`, [ws, id]);
}

/** Purges every incognito chat (run at start, in case the app closed inside one). */
export async function purgeIncognito(db: SqlDb, tenant: Tenant): Promise<void> {
  const rows = await db.select<{ id: string }>(
    `SELECT id FROM threads WHERE workspace_id = ? AND incognito = 1`,
    [tenant.workspaceId],
  );
  for (const r of rows) await purgeThread(db, tenant, r.id);
}
