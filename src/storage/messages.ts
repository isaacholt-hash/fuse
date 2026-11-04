import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import { buildPath, leafUnder } from "./tree";
import type { SqlDb, SqlStatement, SqlValue } from "./sql";
import {
  EMPTY_USAGE,
  USAGE_COLUMNS,
  USAGE_PLACEHOLDERS,
  usageFromRow,
  usageValues,
  type Usage,
  type UsageRow,
} from "./usage";

export type MessageRole = "user" | "assistant" | "system";
export type MessageStatus = "complete" | "streaming" | "stopped" | "error";

/** How an answer's model was picked (RT-01, RT-09); null on answers from before routing. */
export interface MessageRoute {
  mode: "auto" | "tier" | "model";
  tier: "cheap" | "balanced" | "best" | null;
  ruleId: string | null;
  reason: string;
  intent: string | null;
  complexity: string | null;
}

export interface Message {
  id: string;
  threadId: string;
  parentId: string | null;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  errorCode: string | null;
  errorMessage: string | null;
  provider: string | null;
  model: string | null;
  usage: Usage;
  requestId: string | null;
  route: MessageRoute | null;
  /** The same tokens priced on the cheapest Best model; null when unknown. */
  bestCostMicroUsd: number | null;
  /** The answer this one re-ran one tier up (RT-04); null otherwise. */
  escalatedFromId: string | null;
  /** Thumbs up or down on an answer (CH-07); null when not rated. */
  feedback: "up" | "down" | null;
  /** M10 step 22: the provider's summary of the reasoning, where it sends one. */
  reasoningSummary: string | null;
  createdAt: number;
  updatedAt: number;
}

interface MessageRow extends UsageRow {
  id: string;
  thread_id: string;
  parent_id: string | null;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  error_code: string | null;
  error_message: string | null;
  provider: string | null;
  model: string | null;
  request_id: string | null;
  pinned_mode: MessageRoute["mode"] | null;
  tier: MessageRoute["tier"];
  route_rule_id: string | null;
  route_reason: string | null;
  route_intent: string | null;
  route_complexity: string | null;
  best_cost_micro_usd: number | null;
  escalated_from_id: string | null;
  feedback: "up" | "down" | null;
  reasoning_summary: string | null;
  created_at: number;
  updated_at: number;
}

const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  threadId: r.thread_id,
  parentId: r.parent_id,
  role: r.role,
  content: r.content,
  status: r.status,
  errorCode: r.error_code,
  errorMessage: r.error_message,
  provider: r.provider,
  model: r.model,
  usage: usageFromRow(r),
  requestId: r.request_id,
  route: r.pinned_mode
    ? {
        mode: r.pinned_mode,
        tier: r.tier,
        ruleId: r.route_rule_id,
        reason: r.route_reason ?? "",
        intent: r.route_intent,
        complexity: r.route_complexity,
      }
    : null,
  bestCostMicroUsd: r.best_cost_micro_usd,
  escalatedFromId: r.escalated_from_id,
  feedback: r.feedback,
  reasoningSummary: r.reasoning_summary,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface NewMessage {
  threadId: string;
  parentId: string | null;
  role: MessageRole;
  content: string;
  status?: MessageStatus;
  provider?: string | null;
  model?: string | null;
  route?: MessageRoute | null;
  escalatedFromId?: string | null;
}

export async function addMessage(db: SqlDb, tenant: Tenant, m: NewMessage): Promise<string> {
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO messages (id, workspace_id, user_id, thread_id, parent_id, role, content, status,
                           provider, model, pinned_mode, tier, route_rule_id, route_reason,
                           route_intent, route_complexity, escalated_from_id, created_at,
                           updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenant.workspaceId,
      tenant.userId,
      m.threadId,
      m.parentId,
      m.role,
      m.content,
      m.status ?? "complete",
      m.provider ?? null,
      m.model ?? null,
      m.route?.mode ?? null,
      m.route?.tier ?? null,
      m.route?.ruleId ?? null,
      m.route?.reason ?? null,
      m.route?.intent ?? null,
      m.route?.complexity ?? null,
      m.escalatedFromId ?? null,
      now,
      now,
    ],
  );
  await db.execute(
    `UPDATE threads SET last_message_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [now, now, tenant.workspaceId, m.threadId],
  );
  return id;
}

export interface MessageResult {
  content: string;
  status: Exclude<MessageStatus, "streaming">;
  usage?: Usage;
  errorCode?: string | null;
  errorMessage?: string | null;
  requestId?: string | null;
  bestCostMicroUsd?: number | null;
  /** M10 step 22: the provider's reasoning summary, where it sent one. */
  reasoningSummary?: string | null;
}

/** Final state of an assistant message once streaming ends (complete, stopped or error). */
export async function finishMessage(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  r: MessageResult,
): Promise<void> {
  const usage = r.usage ?? EMPTY_USAGE;
  await db.execute(
    `UPDATE messages SET content = ?, status = ?, error_code = ?, error_message = ?, request_id = ?,
       best_cost_micro_usd = ?, reasoning_summary = ?, (${USAGE_COLUMNS}) = (${USAGE_PLACEHOLDERS}),
       updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [
      r.content,
      r.status,
      r.errorCode ?? null,
      r.errorMessage ?? null,
      r.requestId ?? null,
      r.bestCostMicroUsd ?? null,
      r.reasoningSummary ?? null,
      ...usageValues(usage),
      Date.now(),
      tenant.workspaceId,
      id,
    ],
  );
}

/** Saves streamed text so far (no message loss on crash: the row stays `streaming`). */
/** An answer being worked on again (a coding run continued, M6). */
export async function markStreaming(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  await db.execute(
    `UPDATE messages SET status = 'streaming', error_code = NULL, error_message = NULL,
       updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [Date.now(), tenant.workspaceId, id],
  );
}

export async function updateMessageContent(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  content: string,
): Promise<void> {
  await db.execute(
    `UPDATE messages SET content = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [content, Date.now(), tenant.workspaceId, id],
  );
}

export async function deleteMessage(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  const now = Date.now();
  await db.execute(
    `UPDATE messages SET deleted_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [now, now, tenant.workspaceId, id],
  );
}

/** SQLite takes thousands of bound values, but a delete of a huge subtree goes in slices. */
const SLICE = 500;
function slices<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += SLICE) out.push(items.slice(i, i + SLICE));
  return out;
}
const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/**
 * M10 step 18: deletes a message and everything under it (its answers, their branches and
 * stronger re-runs, and every later turn on that branch), as the undo-able first half of a real
 * delete. The rows are marked, not removed: `purgeMessages` removes them, `restoreMessages`
 * brings them back. The thread's leaf moves to the newest surviving message under the parent
 * (a sibling answer stays on screen), or to nothing for a root. Returns what was marked, and
 * the leaf to put back on undo.
 */
export async function deleteMessageTree(
  db: SqlDb,
  tenant: Tenant,
  threadId: string,
  rootId: string,
): Promise<{ ids: string[]; previousLeafId: string | null }> {
  const ws = tenant.workspaceId;
  const statements: SqlStatement[] = [];
  const write = (sql: string, params: SqlValue[] = []) => {
    statements.push({ sql, params });
  };
  const leafRows = await db.select<{ active_leaf_id: string | null }>(
    `SELECT active_leaf_id FROM threads WHERE workspace_id = ? AND id = ?`,
    [ws, threadId],
  );
  const previousLeafId = leafRows[0]?.active_leaf_id ?? null;
  const rows = await db.select<{ id: string }>(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM messages
       WHERE workspace_id = ? AND thread_id = ? AND id = ? AND deleted_at IS NULL
       UNION
       SELECT m.id FROM messages m JOIN sub ON m.parent_id = sub.id OR m.escalated_from_id = sub.id
       WHERE m.workspace_id = ? AND m.deleted_at IS NULL)
     SELECT id FROM sub`,
    [ws, threadId, rootId, ws],
  );
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { ids, previousLeafId };
  const all = await listMessages(db, tenant, threadId);
  const now = Date.now();
  for (const slice of slices(ids)) {
    write(
      `UPDATE messages SET deleted_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id IN (${marks(slice.length)})`,
      [now, now, ws, ...slice],
    );
  }
  const gone = new Set(ids);
  if (previousLeafId === null || gone.has(previousLeafId)) {
    const rest = all.filter((m) => !gone.has(m.id));
    const anchor = all.find((m) => m.id === rootId)?.parentId ?? null;
    const leaf =
      anchor !== null && rest.some((m) => m.id === anchor) ? leafUnder(rest, anchor) : null;
    write(`UPDATE threads SET active_leaf_id = ? WHERE workspace_id = ? AND id = ?`, [
      leaf,
      ws,
      threadId,
    ]);
  }
  await db.batch(statements);
  return { ids, previousLeafId };
}

/** Undo of `deleteMessageTree`: the rows come back and the leaf returns to where it was. */
export async function restoreMessages(
  db: SqlDb,
  tenant: Tenant,
  threadId: string,
  ids: readonly string[],
  leafId: string | null,
): Promise<void> {
  const ws = tenant.workspaceId;
  const statements: SqlStatement[] = [];
  const write = (sql: string, params: SqlValue[] = []) => {
    statements.push({ sql, params });
  };
  const now = Date.now();
  for (const slice of slices(ids)) {
    write(
      `UPDATE messages SET deleted_at = NULL, updated_at = ?
       WHERE workspace_id = ? AND id IN (${marks(slice.length)})`,
      [now, ws, ...slice],
    );
  }
  write(`UPDATE threads SET active_leaf_id = ? WHERE workspace_id = ? AND id = ?`, [
    leafId,
    ws,
    threadId,
  ]);
  await db.batch(statements);
}

/**
 * Removes messages for good: their runs (with steps, changes, approvals and requests), file
 * links, citations, memory links and chunks go; memories, artifact versions and request-log
 * rows that cite them are unlinked; summaries that end on them are dropped (the next assembly
 * rebuilds one). The search index follows through its triggers. Spend is untouched: the
 * request log keeps its rows and its thread. Safe to run again.
 */
export async function purgeMessages(
  db: SqlDb,
  tenant: Tenant,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const ws = tenant.workspaceId;
  const statements: SqlStatement[] = [];
  const write = (sql: string, params: SqlValue[] = []) => {
    statements.push({ sql, params });
  };
  for (const slice of slices(ids)) {
    const inIds = marks(slice.length);
    const runs = `SELECT id FROM runs WHERE workspace_id = ? AND message_id IN (${inIds})`;
    write(
      `UPDATE schedules SET last_run_id = NULL WHERE workspace_id = ? AND last_run_id IN (${runs})`,
      [ws, ws, ...slice],
    );
    write(`DELETE FROM run_requests WHERE workspace_id = ? AND run_id IN (${runs})`, [
      ws,
      ws,
      ...slice,
    ]);
    for (const table of ["run_approvals", "run_live", "run_changes", "run_folders", "run_steps"]) {
      write(`DELETE FROM ${table} WHERE run_id IN (${runs})`, [ws, ...slice]);
    }
    write(`DELETE FROM runs WHERE id IN (${runs})`, [ws, ...slice]);
    for (const table of ["message_files", "message_citations", "message_memories"]) {
      write(`DELETE FROM ${table} WHERE message_id IN (${inIds})`, slice);
    }
    const chunks = `SELECT id FROM chunks WHERE workspace_id = ? AND source_kind = 'message' AND source_id IN (${inIds})`;
    write(`DELETE FROM chunk_vectors WHERE chunk_id IN (${chunks})`, [ws, ...slice]);
    write(
      `DELETE FROM chunks WHERE workspace_id = ? AND source_kind = 'message' AND source_id IN (${inIds})`,
      [ws, ...slice],
    );
    write(
      `UPDATE memories SET source_message_id = NULL WHERE workspace_id = ? AND source_message_id IN (${inIds})`,
      [ws, ...slice],
    );
    write(
      `UPDATE artifact_versions SET message_id = NULL WHERE workspace_id = ? AND message_id IN (${inIds})`,
      [ws, ...slice],
    );
    write(`DELETE FROM thread_summaries WHERE workspace_id = ? AND upto_message_id IN (${inIds})`, [
      ws,
      ...slice,
    ]);
    write(
      `UPDATE request_log SET message_id = NULL WHERE workspace_id = ? AND message_id IN (${inIds})`,
      [ws, ...slice],
    );
    write(
      `UPDATE threads SET active_leaf_id = NULL WHERE workspace_id = ? AND active_leaf_id IN (${inIds})`,
      [ws, ...slice],
    );
  }
  // A child is always newer than its parent, so newest first never leaves a child pointing at
  // a parent that's already gone.
  const order: { id: string; created_at: number }[] = [];
  for (const slice of slices(ids)) {
    order.push(
      ...(await db.select<{ id: string; created_at: number }>(
        `SELECT id, created_at FROM messages WHERE workspace_id = ? AND id IN (${marks(slice.length)})`,
        [ws, ...slice],
      )),
    );
  }
  order.sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
  for (const slice of slices(order.map((r) => r.id))) {
    write(`DELETE FROM messages WHERE workspace_id = ? AND id IN (${marks(slice.length)})`, [
      ws,
      ...slice,
    ]);
  }
  await db.batch(statements);
}

/** Messages of a thread in order. M0 threads are linear, so this is the path to the leaf. */
export async function listMessages(
  db: SqlDb,
  tenant: Tenant,
  threadId: string,
): Promise<Message[]> {
  const rows = await db.select<MessageRow>(
    `SELECT id, thread_id, parent_id, role, content, status, error_code, error_message, provider,
            model, ${USAGE_COLUMNS}, request_id, pinned_mode, tier, route_rule_id, route_reason,
            route_intent, route_complexity, best_cost_micro_usd, escalated_from_id, feedback,
            reasoning_summary, created_at, updated_at
     FROM messages
     WHERE workspace_id = ? AND thread_id = ? AND deleted_at IS NULL
     ORDER BY created_at, id`,
    [tenant.workspaceId, threadId],
  );
  return rows.map(toMessage);
}

/** Messages left `streaming` by a crash or forced close; shown as interrupted (CH-10). */
export async function markInterruptedMessages(db: SqlDb, tenant: Tenant): Promise<number> {
  const result = await db.execute(
    `UPDATE messages SET status = 'stopped', error_code = 'interrupted', updated_at = ?
     WHERE workspace_id = ? AND status = 'streaming'`,
    [Date.now(), tenant.workspaceId],
  );
  return result.rowsAffected;
}

/** Thumbs up or down on an answer; null clears it. */
export async function setFeedback(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  feedback: "up" | "down" | null,
): Promise<void> {
  await db.execute(
    `UPDATE messages SET feedback = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [feedback, Date.now(), tenant.workspaceId, id],
  );
}

/** The messages on screen: root to the thread's active leaf (CH-04), oldest first. */
export async function listPath(
  db: SqlDb,
  tenant: Tenant,
  threadId: string,
): Promise<{ all: Message[]; path: Message[] }> {
  const all = await listMessages(db, tenant, threadId);
  const rows = await db.select<{ active_leaf_id: string | null }>(
    `SELECT active_leaf_id FROM threads WHERE workspace_id = ? AND id = ?`,
    [tenant.workspaceId, threadId],
  );
  return { all, path: buildPath(all, rows[0]?.active_leaf_id ?? null) };
}

/** The answer moved to another model before any text arrived (failover, MM-06). */
export async function setMessageModel(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  provider: string,
  model: string,
): Promise<void> {
  await db.execute(
    `UPDATE messages SET provider = ?, model = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [provider, model, Date.now(), tenant.workspaceId, id],
  );
}
