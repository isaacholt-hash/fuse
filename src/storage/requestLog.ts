import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";
import {
  USAGE_COLUMNS,
  USAGE_PLACEHOLDERS,
  usageFromRow,
  usageValues,
  type Usage,
  type UsageRow,
} from "./usage";

export type RequestPurpose =
  "chat" | "key_test" | "title" | "classify" | "memory" | "summary" | "embed";

/** One provider HTTP call. Never put headers, bodies or keys in any field. */
export interface RequestLogEntry {
  threadId: string | null;
  messageId: string | null;
  purpose: RequestPurpose;
  provider: string;
  model: string;
  attempt: number;
  usage: Usage;
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  providerRequestId: string | null;
  /** Chat calls: the answer's tier and the routing rule that fired (RT-09). */
  tier?: string | null;
  routeRuleId?: string | null;
}

export interface RequestLogRecord extends RequestLogEntry {
  id: string;
  createdAt: number;
}

interface RequestLogRow extends UsageRow {
  id: string;
  thread_id: string | null;
  message_id: string | null;
  purpose: RequestPurpose;
  provider: string;
  model: string;
  attempt: number;
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  provider_request_id: string | null;
  tier: string | null;
  route_rule_id: string | null;
  created_at: number;
}

export async function logRequest(db: SqlDb, tenant: Tenant, e: RequestLogEntry): Promise<string> {
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO request_log (id, workspace_id, user_id, thread_id, message_id, purpose, provider,
       model, attempt, ${USAGE_COLUMNS}, http_status, error_code, error_message,
       provider_request_id, tier, route_rule_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${USAGE_PLACEHOLDERS}, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenant.workspaceId,
      tenant.userId,
      e.threadId,
      e.messageId,
      e.purpose,
      e.provider,
      e.model,
      e.attempt,
      ...usageValues(e.usage),
      e.httpStatus,
      e.errorCode,
      e.errorMessage,
      e.providerRequestId,
      e.tier ?? null,
      e.routeRuleId ?? null,
      now,
      now,
    ],
  );
  return id;
}

/** Fewer answers than this from a model and its speed isn't known yet. */
const MIN_SPEED_SAMPLES = 3;

/**
 * RT-06: each model's median time to first token over answers since `since`, keyed
 * `provider/model`. Only successful chat answers count; models with too few are left out.
 */
export async function medianFirstTokenMs(
  db: SqlDb,
  tenant: Tenant,
  since: number,
): Promise<Record<string, number>> {
  const rows = await db.select<{ provider: string; model: string; ttft_ms: number }>(
    `SELECT provider, model, ttft_ms FROM request_log
     WHERE workspace_id = ? AND purpose = 'chat' AND error_code IS NULL AND ttft_ms IS NOT NULL
       AND created_at >= ?`,
    [tenant.workspaceId, since],
  );
  const byModel = new Map<string, number[]>();
  for (const r of rows) {
    const key = `${r.provider}/${r.model}`;
    byModel.set(key, [...(byModel.get(key) ?? []), r.ttft_ms]);
  }
  const out: Record<string, number> = {};
  for (const [key, times] of byModel) {
    if (times.length < MIN_SPEED_SAMPLES) continue;
    const sorted = [...times].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    out[key] =
      sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return out;
}

export async function listRecentRequests(
  db: SqlDb,
  tenant: Tenant,
  limit = 100,
): Promise<RequestLogRecord[]> {
  const rows = await db.select<RequestLogRow>(
    `SELECT id, thread_id, message_id, purpose, provider, model, attempt, ${USAGE_COLUMNS},
            http_status, error_code, error_message, provider_request_id, tier, route_rule_id,
            created_at
     FROM request_log WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [tenant.workspaceId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    threadId: r.thread_id,
    messageId: r.message_id,
    purpose: r.purpose,
    provider: r.provider,
    model: r.model,
    attempt: r.attempt,
    usage: usageFromRow(r),
    httpStatus: r.http_status,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    providerRequestId: r.provider_request_id,
    tier: r.tier,
    routeRuleId: r.route_rule_id,
    createdAt: r.created_at,
  }));
}
