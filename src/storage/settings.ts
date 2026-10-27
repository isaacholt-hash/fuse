import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

/** Per-user preferences, stored as key/value text. Never keys or other secrets. */
export async function getSetting(db: SqlDb, tenant: Tenant, key: string): Promise<string | null> {
  const rows = await db.select<{ value: string }>(
    `SELECT value FROM settings WHERE workspace_id = ? AND user_id = ? AND key = ?`,
    [tenant.workspaceId, tenant.userId, key],
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(
  db: SqlDb,
  tenant: Tenant,
  key: string,
  value: string,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO settings (id, workspace_id, user_id, key, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, user_id, key)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [uuidv7(now), tenant.workspaceId, tenant.userId, key, value, now, now],
  );
}

export interface MemorySettings {
  /** Ask a Cheap model for memory suggestions when you leave a chat (PM-03). */
  suggest: boolean;
  /** Most tokens of memories sent with one message (PM-04). */
  budgetTokens: number;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = { suggest: true, budgetTokens: 1500 };
export const MAX_MEMORY_BUDGET = 8000;

export async function getMemorySettings(db: SqlDb, tenant: Tenant): Promise<MemorySettings> {
  const suggest = await getSetting(db, tenant, "memory.suggest");
  const budget = Number((await getSetting(db, tenant, "memory.budget_tokens")) ?? NaN);
  return {
    suggest: suggest === null ? DEFAULT_MEMORY_SETTINGS.suggest : suggest === "on",
    budgetTokens:
      Number.isInteger(budget) && budget >= 0
        ? Math.min(budget, MAX_MEMORY_BUDGET)
        : DEFAULT_MEMORY_SETTINGS.budgetTokens,
  };
}

export async function setMemorySettings(
  db: SqlDb,
  tenant: Tenant,
  value: MemorySettings,
): Promise<void> {
  await setSetting(db, tenant, "memory.suggest", value.suggest ? "on" : "off");
  const budget = Math.round(Math.min(Math.max(value.budgetTokens, 0), MAX_MEMORY_BUDGET));
  await setSetting(db, tenant, "memory.budget_tokens", String(budget));
}
