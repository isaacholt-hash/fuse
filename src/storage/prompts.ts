/** The prompt library (CH-12): saved prompts, global or per project, with {{variables}}. */
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export interface SavedPrompt {
  id: string;
  name: string;
  body: string;
  /** Null: every chat. */
  projectId: string | null;
  updatedAt: number;
}

interface PromptRow {
  id: string;
  name: string;
  body: string;
  project_id: string | null;
  updated_at: number;
}

export async function listPrompts(db: SqlDb, tenant: Tenant): Promise<SavedPrompt[]> {
  const rows = await db.select<PromptRow>(
    `SELECT id, name, body, project_id, updated_at FROM prompts
     WHERE workspace_id = ? ORDER BY name COLLATE NOCASE, id`,
    [tenant.workspaceId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    body: r.body,
    projectId: r.project_id,
    updatedAt: r.updated_at,
  }));
}

/** Adds a prompt, or updates it when `id` is given. */
export async function savePrompt(
  db: SqlDb,
  tenant: Tenant,
  prompt: { id?: string; name: string; body: string; projectId: string | null },
): Promise<string> {
  const now = Date.now();
  if (prompt.id) {
    await db.execute(
      `UPDATE prompts SET name = ?, body = ?, project_id = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ?`,
      [prompt.name, prompt.body, prompt.projectId, now, tenant.workspaceId, prompt.id],
    );
    return prompt.id;
  }
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO prompts (id, workspace_id, user_id, project_id, name, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, tenant.workspaceId, tenant.userId, prompt.projectId, prompt.name, prompt.body, now, now],
  );
  return id;
}

export async function deletePrompt(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  await db.execute(`DELETE FROM prompts WHERE workspace_id = ? AND id = ?`, [
    tenant.workspaceId,
    id,
  ]);
}

/** The {{variables}} in a prompt, in order of first use. */
export function promptVariables(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1] ?? ""))].filter(
    Boolean,
  );
}

/** The prompt with its variables filled in. */
export function fillPrompt(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, name: string) => values[name] ?? all);
}
