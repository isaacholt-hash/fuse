import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import { buildPath } from "./tree";
import type { SqlDb } from "./sql";
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
       best_cost_micro_usd = ?, (${USAGE_COLUMNS}) = (${USAGE_PLACEHOLDERS}), updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [
      r.content,
      r.status,
      r.errorCode ?? null,
      r.errorMessage ?? null,
      r.requestId ?? null,
      r.bestCostMicroUsd ?? null,
      ...usageValues(usage),
      Date.now(),
      tenant.workspaceId,
      id,
    ],
  );
}

/** Saves streamed text so far (no message loss on crash: the row stays `streaming`). */
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
            created_at, updated_at
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
