/**
 * M18.1: messages the owner explicitly queued while offline (PL-05). Each row keeps one
 * immutable dispatch identity from queueing to sending, and belongs to the installation that
 * queued it. Nothing here dispatches; delivery (M18.2) claims a row before it sends.
 */
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export type QueueState = "queued" | "dispatching" | "sent" | "cancelled" | "blocked" | "unknown";

export interface QueuedMessage {
  /** The dispatch identity: fixed when queued, never reused. */
  id: string;
  threadId: string;
  origin: string;
  text: string;
  effort: string | null;
  state: QueueState;
  reason: string | null;
  messageId: string | null;
  createdAt: number;
}

const MAX_TEXT = 100_000;

interface Row {
  id: string;
  thread_id: string;
  origin: string;
  text: string;
  effort: string | null;
  state: QueueState;
  reason: string | null;
  message_id: string | null;
  created_at: number;
}
const fromRow = (r: Row): QueuedMessage => ({
  id: r.id,
  threadId: r.thread_id,
  origin: r.origin,
  text: r.text,
  effort: r.effort,
  state: r.state,
  reason: r.reason,
  messageId: r.message_id,
  createdAt: r.created_at,
});

function checkText(text: string): string {
  const t = text.trim();
  if (!t) throw new Error("A queued message can't be empty.");
  if (t.length > MAX_TEXT) throw new Error("A queued message can be up to 100,000 characters.");
  return t;
}

/** Queues a message for a saved, non-incognito chat on this installation. */
export async function queueMessage(
  db: SqlDb,
  t: Tenant,
  p: { threadId: string; text: string; effort: string | null; origin: string },
): Promise<QueuedMessage> {
  const text = checkText(p.text);
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO offline_queue(id,workspace_id,user_id,thread_id,origin,text,effort,state,
       created_at,updated_at) VALUES (?,?,?,?,?,?,?,'queued',?,?)`,
    [id, t.workspaceId, t.userId, p.threadId, p.origin, text, p.effort, now, now],
  );
  return {
    id,
    threadId: p.threadId,
    origin: p.origin,
    text,
    effort: p.effort,
    state: "queued",
    reason: null,
    messageId: null,
    createdAt: now,
  };
}

/** What still needs the owner: waiting, blocked or uncertain messages, oldest first. */
export async function listQueue(db: SqlDb, t: Tenant, threadId?: string): Promise<QueuedMessage[]> {
  const rows = await db.select<Row>(
    `SELECT id,thread_id,origin,text,effort,state,reason,message_id,created_at FROM offline_queue
     WHERE workspace_id=? AND user_id=? AND state IN ('queued','dispatching','blocked','unknown')
       ${threadId ? "AND thread_id=?" : ""}
     ORDER BY created_at,id`,
    threadId ? [t.workspaceId, t.userId, threadId] : [t.workspaceId, t.userId],
  );
  return rows.map(fromRow);
}

/** Changes a message that is still only waiting; its dispatch identity stays the same. */
export async function editQueued(db: SqlDb, t: Tenant, id: string, text: string): Promise<void> {
  const result = await db.batch([
    {
      sql: `UPDATE offline_queue SET text=?,updated_at=? WHERE workspace_id=? AND user_id=? AND id=?
            AND state='queued'`,
      params: [checkText(text), Date.now(), t.workspaceId, t.userId, id],
    },
  ]);
  if (result[0]?.rowsAffected !== 1)
    throw new Error("That message isn't waiting any more, so it can't be edited.");
}

/** Removes a message from the queue: waiting, blocked or uncertain ones. Sent ones stay sent. */
export async function cancelQueued(db: SqlDb, t: Tenant, id: string): Promise<void> {
  await db.execute(
    `UPDATE offline_queue SET state='cancelled',updated_at=? WHERE workspace_id=? AND user_id=?
     AND id=? AND state IN ('queued','blocked','unknown')`,
    [Date.now(), t.workspaceId, t.userId, id],
  );
}

/** Waiting messages per chat, for the sidebar and the reconnect notice. */
export async function queuedCounts(db: SqlDb, t: Tenant): Promise<Map<string, number>> {
  const rows = await db.select<{ thread_id: string; n: number }>(
    `SELECT thread_id,COUNT(*) AS n FROM offline_queue WHERE workspace_id=? AND user_id=?
     AND state='queued' GROUP BY thread_id`,
    [t.workspaceId, t.userId],
  );
  return new Map(rows.map((r) => [r.thread_id, r.n]));
}
