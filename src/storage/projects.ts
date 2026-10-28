import type { ProviderId } from "@/catalog/catalog";
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

/** A project (PM-01): instructions and a default model shared by its threads. */
export interface Project {
  id: string;
  name: string;
  instructions: string;
  /** The model new chats in this project are pinned to; null means they start on Auto. */
  defaultModel: { provider: ProviderId; id: string } | null;
  /** Or a tier new chats start pinned to (RT-01); ignored when there's a default model. */
  defaultTier: "balanced" | "best" | null;
  createdAt: number;
  updatedAt: number;
}

interface ProjectRow {
  id: string;
  name: string;
  instructions: string;
  default_provider: string | null;
  default_model: string | null;
  default_tier: "balanced" | "best" | null;
  created_at: number;
  updated_at: number;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  instructions: r.instructions,
  defaultModel:
    (r.default_provider === "openai" || r.default_provider === "anthropic") && r.default_model
      ? { provider: r.default_provider, id: r.default_model }
      : null,
  defaultTier: r.default_tier,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const COLUMNS =
  "id, name, instructions, default_provider, default_model, default_tier, created_at, updated_at";

export async function createProject(db: SqlDb, tenant: Tenant, name: string): Promise<Project> {
  const now = Date.now();
  const id = uuidv7(now);
  await db.execute(
    `INSERT INTO projects (id, workspace_id, user_id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, tenant.workspaceId, tenant.userId, cleanName(name), now, now],
  );
  const project = await getProject(db, tenant, id);
  if (!project) throw new Error("Project insert failed");
  return project;
}

export async function getProject(db: SqlDb, tenant: Tenant, id: string): Promise<Project | null> {
  const rows = await db.select<ProjectRow>(
    `SELECT ${COLUMNS} FROM projects WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`,
    [tenant.workspaceId, id],
  );
  const row = rows[0];
  return row ? toProject(row) : null;
}

/** Alphabetical, case-insensitive. */
export async function listProjects(db: SqlDb, tenant: Tenant): Promise<Project[]> {
  const rows = await db.select<ProjectRow>(
    `SELECT ${COLUMNS} FROM projects WHERE workspace_id = ? AND deleted_at IS NULL
     ORDER BY name COLLATE NOCASE, id`,
    [tenant.workspaceId],
  );
  return rows.map(toProject);
}

export interface ProjectChanges {
  name: string;
  instructions: string;
  defaultModel: Project["defaultModel"];
  defaultTier?: Project["defaultTier"];
}

export async function updateProject(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  changes: ProjectChanges,
): Promise<void> {
  await db.execute(
    `UPDATE projects SET name = ?, instructions = ?, default_provider = ?, default_model = ?,
       default_tier = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [
      cleanName(changes.name),
      changes.instructions.trim(),
      changes.defaultModel?.provider ?? null,
      changes.defaultModel?.id ?? null,
      changes.defaultModel ? null : (changes.defaultTier ?? null),
      Date.now(),
      tenant.workspaceId,
      id,
    ],
  );
}

/** Soft-deletes the project. Its chats are kept and move out to "no project". */
export async function deleteProject(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  const now = Date.now();
  await db.execute(
    `UPDATE threads SET project_id = NULL, updated_at = ? WHERE workspace_id = ? AND project_id = ?`,
    [now, tenant.workspaceId, id],
  );
  await db.execute(
    `UPDATE projects SET deleted_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [now, now, tenant.workspaceId, id],
  );
}

function cleanName(name: string): string {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n) throw new Error("A project needs a name.");
  return n.slice(0, 80);
}
