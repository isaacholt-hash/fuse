/**
 * Exact-match response cache (M7 step 11, LL-06, RT-13). A request seen before (same model,
 * same system prompt with its instructions and memories, same messages, same project) gets the
 * stored answer at $0, until it expires. Never semantic: one character different is a miss.
 * Only requests that can't go stale or be personal are offered (see `chatCacheable`).
 */
import type { Tenant } from "@/storage/defaults";
import { uuidv7 } from "@/storage/ids";
import type { SqlDb } from "@/storage/sql";

export type CacheKind = "chat" | "classify";

/** Chat answers keep a day; a classification of the same words, a month. */
export const TTL_MS: Record<CacheKind, number> = {
  chat: 24 * 60 * 60 * 1000,
  classify: 30 * 24 * 60 * 60 * 1000,
};

/** Bumped when what's stored or how it's keyed changes, so old entries never match. */
const KEY_VERSION = "1";

/** SHA-256 hex of the request's parts, in order. */
export async function cacheKey(parts: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([KEY_VERSION, ...parts]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CacheHit {
  response: string;
  model: string;
  costMicroUsd: number;
  createdAt: number;
}

/** The stored answer for `key` in `scope`, if it hasn't expired; counts the hit. */
export async function cacheGet(
  db: SqlDb,
  tenant: Tenant,
  key: string,
  scope: string,
  now = Date.now(),
): Promise<CacheHit | null> {
  const rows = await db.select<{
    id: string;
    scope: string;
    model: string;
    response: string;
    cost_micro_usd: number;
    created_at: number;
    expires_at: number;
  }>(
    `SELECT id, scope, model, response, cost_micro_usd, created_at, expires_at FROM response_cache
     WHERE workspace_id = ? AND key = ?`,
    [tenant.workspaceId, key],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at <= now) {
    await db.execute("DELETE FROM response_cache WHERE workspace_id = ? AND id = ?", [
      tenant.workspaceId,
      row.id,
    ]);
    return null;
  }
  // The scope is in the key too; this is the second lock on cross-project reuse.
  if (row.scope !== scope) return null;
  await db.execute("UPDATE response_cache SET hits = hits + 1 WHERE workspace_id = ? AND id = ?", [
    tenant.workspaceId,
    row.id,
  ]);
  return {
    response: row.response,
    model: row.model,
    costMicroUsd: row.cost_micro_usd,
    createdAt: row.created_at,
  };
}

export async function cachePut(
  db: SqlDb,
  tenant: Tenant,
  entry: {
    key: string;
    kind: CacheKind;
    scope: string;
    model: string;
    response: string;
    costMicroUsd: number;
  },
  now = Date.now(),
): Promise<void> {
  await db.execute(
    `INSERT INTO response_cache (id, workspace_id, user_id, key, kind, scope, model, response,
       cost_micro_usd, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, key) DO UPDATE SET response = excluded.response,
       model = excluded.model, cost_micro_usd = excluded.cost_micro_usd,
       created_at = excluded.created_at, expires_at = excluded.expires_at, hits = 0`,
    [
      uuidv7(now),
      tenant.workspaceId,
      tenant.userId,
      entry.key,
      entry.kind,
      entry.scope,
      entry.model,
      entry.response,
      entry.costMicroUsd,
      now,
      now + TTL_MS[entry.kind],
    ],
  );
}

/** Empties the cache (Settings, and when everything is deleted). */
export async function cacheClear(db: SqlDb, tenant: Tenant): Promise<void> {
  await db.execute("DELETE FROM response_cache WHERE workspace_id = ?", [tenant.workspaceId]);
}

/**
 * Words that make an answer time-sensitive (it may change by tomorrow), about you, or high
 * stakes (health, money, law, safety). Such questions are never answered from the cache.
 */
const DYNAMIC =
  /\b(today|tonight|tomorrow|yesterday|now|current(ly)?|latest|recent(ly)?|this (week|month|year)|news|price|prices|cost of|weather|stock|score|live|update[sd]?|20\d\d)\b/i;
const PERSONAL = /\b(i|i'm|i've|me|my|mine|we|our|us)\b/i;
const HIGH_STAKES =
  /\b(medic(al|ine|ation)|dose|dosage|symptom|diagnos\w*|doctor|pregnan\w*|legal|lawyer|lawsuit|contract|tax(es)?|invest\w*|loan|mortgage|insurance|suicid\w*|emergency|overdose|safety)\b/i;

/**
 * Whether a chat request may be answered from (and stored in) the cache: the first question of
 * a chat, with nothing attached, no web search, not incognito, no memories sent with it, and
 * nothing time-sensitive, personal or high-stakes in it.
 */
export function chatCacheable(r: {
  question: string;
  firstInChat: boolean;
  files: number;
  webSearch: boolean;
  incognito: boolean;
  memoriesSent: number;
}): boolean {
  const q = r.question.trim();
  return (
    r.firstInChat &&
    r.files === 0 &&
    !r.webSearch &&
    !r.incognito &&
    r.memoriesSent === 0 &&
    q.length > 0 &&
    q.length <= 4000 &&
    !DYNAMIC.test(q) &&
    !PERSONAL.test(q) &&
    !HIGH_STAKES.test(q)
  );
}
