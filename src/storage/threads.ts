import type { ProviderId } from "@/catalog/catalog";
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import { getSetting, setSetting } from "./settings";
import type { SqlDb } from "./sql";

/** M10 step 16: how a session's runs go. Null: the project's default, then FUSE's. */
export interface ThreadSession {
  mode: "plan" | "ask" | "auto_edit" | null;
  /** Each run on a branch of its own (CA-05). */
  newBranch: boolean | null;
  /** This computer, or handed over to HULK. */
  where: "local" | "hulk" | null;
  capMicroUsd: number | null;
}

/** M10 step 12 (CH-19): a chat, or a Code or Work session (the Code area). */
export type ThreadKind = "chat" | "code" | "work";

export interface Thread {
  id: string;
  title: string;
  titleSource: "user" | "auto";
  /** Which area it lives in. Threads that held a run before 0053 became sessions. */
  kind: ThreadKind;
  /**
   * M10 step 13: when it was last opened. 0 means marked unread; null means never opened here
   * (a result after it was made counts as new).
   */
  seenAt: number | null;
  /** M10 step 15: the scheduled task it was made for, if any. */
  scheduleId: string | null;
  /** M10 step 16: a session's own settings; null fields fall back to the project's, then FUSE's. */
  session: ThreadSession;
  /** M10 step 17: the chat or session this one was handed off from. */
  handoffFromId: string | null;
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
  /** CH-02: pinned to the top of the sidebar, or archived out of it; null when not. */
  pinnedAt: number | null;
  archivedAt: number | null;
  /** CH-02 tags, sorted. */
  tags: string[];
  /** RT-06: Auto stays on this provider in this chat; null lets it pick either. */
  stayProvider: ProviderId | null;
}

interface ThreadRow {
  id: string;
  title: string;
  title_source: "user" | "auto";
  kind: ThreadKind;
  seen_at: number | null;
  schedule_id: string | null;
  run_mode: "plan" | "ask" | "auto_edit" | null;
  run_branch: number | null;
  run_where: "local" | "hulk" | null;
  run_cap_micro_usd: number | null;
  handoff_from_id: string | null;
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
  pinned_at: number | null;
  archived_at: number | null;
  tags: string | null;
  stay_provider: string | null;
}

const TAG_SEP = "\u001f";

const toThread = (r: ThreadRow): Thread => ({
  id: r.id,
  title: r.title,
  titleSource: r.title_source,
  kind: r.kind,
  seenAt: r.seen_at,
  scheduleId: r.schedule_id,
  session: {
    mode: r.run_mode,
    newBranch: r.run_branch === null ? null : r.run_branch === 1,
    where: r.run_where,
    capMicroUsd: r.run_cap_micro_usd,
  },
  handoffFromId: r.handoff_from_id,
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
  pinnedAt: r.pinned_at,
  archivedAt: r.archived_at,
  tags: r.tags ? r.tags.split(TAG_SEP).sort() : [],
  stayProvider:
    r.stay_provider === "openai" || r.stay_provider === "anthropic" ? r.stay_provider : null,
});

const SELECT_THREAD = `
  SELECT t.id, t.title, t.title_source, t.kind, t.seen_at, t.schedule_id, t.run_mode,
         t.run_branch, t.run_where, t.run_cap_micro_usd, t.handoff_from_id, t.last_message_at, t.created_at, t.updated_at,
         t.web_search,
         t.instructions, t.project_id, t.memory_injection, t.memory_checked_at,
         t.pinned_tier, t.pinned_provider, t.pinned_model, t.active_leaf_id, t.incognito,
         t.pinned_at, t.archived_at, t.stay_provider,
         (SELECT GROUP_CONCAT(g.tag, char(31)) FROM thread_tags g WHERE g.thread_id = t.id) AS tags,
         COALESCE((SELECT SUM(m.cost_micro_usd) FROM messages m
                   WHERE m.thread_id = t.id AND m.deleted_at IS NULL), 0) AS cost_micro_usd
  FROM threads t`;

export async function createThread(
  db: SqlDb,
  tenant: Tenant,
  title?: string,
  projectId: string | null = null,
  incognito = false,
  kind: ThreadKind = "chat",
): Promise<Thread> {
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO threads
       (id, workspace_id, user_id, title, title_source, kind, project_id, incognito,
        memory_injection, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'auto', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenant.workspaceId,
      tenant.userId,
      title ?? (kind === "chat" ? "New chat" : "New session"),
      kind,
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
  await db.execute(`DELETE FROM thread_tags WHERE workspace_id = ? AND thread_id = ?`, [ws, id]);
  await db.execute(`DELETE FROM threads WHERE workspace_id = ? AND id = ?`, [ws, id]);
}

/** A tag as stored: lowercase, spaces as dashes, no leading #, at most 32 characters. */
export function normaliseTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .slice(0, 32);
}

/** RT-06: keeps Auto on one provider in this chat, or lets it pick either again (null). */
export async function setThreadStay(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  provider: ProviderId | null,
): Promise<void> {
  await db.execute(`UPDATE threads SET stay_provider = ? WHERE workspace_id = ? AND id = ?`, [
    provider,
    tenant.workspaceId,
    id,
  ]);
}

/** Pins a chat to the top of the sidebar, or unpins it (CH-02). */
export async function setThreadPinned(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  pinned: boolean,
): Promise<void> {
  await db.execute(`UPDATE threads SET pinned_at = ? WHERE workspace_id = ? AND id = ?`, [
    pinned ? Date.now() : null,
    tenant.workspaceId,
    id,
  ]);
}

/** Archives a chat out of the sidebar, or brings it back (CH-02). */
export async function setThreadArchived(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  archived: boolean,
): Promise<void> {
  await db.execute(`UPDATE threads SET archived_at = ? WHERE workspace_id = ? AND id = ?`, [
    archived ? Date.now() : null,
    tenant.workspaceId,
    id,
  ]);
}

/** Replaces a chat's tags; blanks and repeats are dropped. */
export async function setThreadTags(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  tags: readonly string[],
): Promise<string[]> {
  const clean = [...new Set(tags.map(normaliseTag).filter(Boolean))].sort();
  await db.execute(`DELETE FROM thread_tags WHERE workspace_id = ? AND thread_id = ?`, [
    tenant.workspaceId,
    id,
  ]);
  const now = Date.now();
  for (const tag of clean) {
    await db.execute(
      `INSERT INTO thread_tags (id, workspace_id, user_id, thread_id, tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuidv7(now), tenant.workspaceId, tenant.userId, id, tag, now, now],
    );
  }
  return clean;
}

/** Purges every incognito chat (run at start, in case the app closed inside one). */
export async function purgeIncognito(db: SqlDb, tenant: Tenant): Promise<void> {
  const rows = await db.select<{ id: string }>(
    `SELECT id FROM threads WHERE workspace_id = ? AND incognito = 1`,
    [tenant.workspaceId],
  );
  for (const r of rows) await purgeThread(db, tenant, r.id);
}

/** M10 step 13: the thread was opened; results up to now have been seen. */
export async function markThreadSeen(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  at = Date.now(),
): Promise<void> {
  await db.execute("UPDATE threads SET seen_at = ? WHERE workspace_id = ? AND id = ?", [
    at,
    tenant.workspaceId,
    id,
  ]);
}

/** M10 step 13: "Mark as unread": bold in the sidebar until it's opened again. */
export async function markThreadUnread(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  await db.execute("UPDATE threads SET seen_at = 0 WHERE workspace_id = ? AND id = ?", [
    tenant.workspaceId,
    id,
  ]);
}

const SEEN_SINCE_KEY = "threads.seenSince";

/**
 * M10 step 13: once per database, every thread already here counts as seen, so the first start
 * with unread marks doesn't make every old chat with a run look new. Threads made afterwards
 * (a scheduled task's, say) start unseen.
 */
export async function settleSeen(db: SqlDb, tenant: Tenant, now = Date.now()): Promise<void> {
  if (await getSetting(db, tenant, SEEN_SINCE_KEY)) return;
  await db.execute("UPDATE threads SET seen_at = ? WHERE workspace_id = ? AND seen_at IS NULL", [
    now,
    tenant.workspaceId,
  ]);
  await setSetting(db, tenant, SEEN_SINCE_KEY, String(now));
}

/** M10 step 15: the scheduled task a thread was made for, so every run of a task can be found. */
export async function setThreadSchedule(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  scheduleId: string,
): Promise<void> {
  await db.execute("UPDATE threads SET schedule_id = ? WHERE workspace_id = ? AND id = ?", [
    scheduleId,
    tenant.workspaceId,
    id,
  ]);
}

/** M10 step 16: saves a session's settings; a field left out of the patch is kept. */
export async function setThreadSession(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  patch: Partial<ThreadSession>,
): Promise<void> {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if ("mode" in patch) {
    sets.push("run_mode = ?");
    args.push(patch.mode ?? null);
  }
  if ("newBranch" in patch) {
    sets.push("run_branch = ?");
    args.push(
      patch.newBranch === undefined || patch.newBranch === null ? null : patch.newBranch ? 1 : 0,
    );
  }
  if ("where" in patch) {
    sets.push("run_where = ?");
    args.push(patch.where ?? null);
  }
  if ("capMicroUsd" in patch) {
    sets.push("run_cap_micro_usd = ?");
    args.push(patch.capMicroUsd ?? null);
  }
  if (sets.length === 0) return;
  await db.execute(
    `UPDATE threads SET ${sets.join(", ")}, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [...args, Date.now(), tenant.workspaceId, id],
  );
}

/** M10 step 17: "Continue in Code" and "Discuss in Chat" link the new thread to where it began. */
export async function setThreadHandoff(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  fromId: string,
): Promise<void> {
  await db.execute("UPDATE threads SET handoff_from_id = ? WHERE workspace_id = ? AND id = ?", [
    fromId,
    tenant.workspaceId,
    id,
  ]);
}
