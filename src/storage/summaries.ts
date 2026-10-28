/** Rolling summaries of a long thread's older turns (PM-06). */
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { Message } from "./messages";
import type { SqlDb } from "./sql";

export interface ThreadSummary {
  id: string;
  uptoMessageId: string;
  summary: string;
  createdAt: number;
}

export async function listSummaries(
  db: SqlDb,
  tenant: Tenant,
  threadId: string,
): Promise<ThreadSummary[]> {
  const rows = await db.select<{
    id: string;
    upto_message_id: string;
    summary: string;
    created_at: number;
  }>(
    `SELECT id, upto_message_id, summary, created_at FROM thread_summaries
     WHERE workspace_id = ? AND thread_id = ? ORDER BY created_at, id`,
    [tenant.workspaceId, threadId],
  );
  return rows.map((r) => ({
    id: r.id,
    uptoMessageId: r.upto_message_id,
    summary: r.summary,
    createdAt: r.created_at,
  }));
}

export async function addSummary(
  db: SqlDb,
  tenant: Tenant,
  threadId: string,
  uptoMessageId: string,
  summary: string,
): Promise<string> {
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO thread_summaries (id, workspace_id, user_id, thread_id, upto_message_id, summary,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, tenant.workspaceId, tenant.userId, threadId, uptoMessageId, summary, now, now],
  );
  return id;
}

/** The summary that applies to this path: the one reaching furthest along it, if any. */
export function activeSummary(
  path: readonly Message[],
  summaries: readonly ThreadSummary[],
): { summary: ThreadSummary; uptoIndex: number } | null {
  let best: { summary: ThreadSummary; uptoIndex: number } | null = null;
  for (const s of summaries) {
    const i = path.findIndex((m) => m.id === s.uptoMessageId);
    if (i >= 0 && (!best || i > best.uptoIndex)) best = { summary: s, uptoIndex: i };
  }
  return best;
}
