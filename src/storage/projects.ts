import type { ProviderId } from "@/catalog/catalog";
import { grantFolder, linkProjectFolder, listProjectFolders, unlinkProjectFolder } from "./folders";
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
  /** SE-13: Normal, Local only (nothing is sent) or Cloud only (never a local model). */
  privacyMode: PrivacyMode;
  /** SE-13: whether its content may go to a provider to be embedded for search. */
  allowEmbeddings: boolean;
  /** CA-01: the linked repository folder for the coding agent; null when none. */
  repoRoot: string | null;
  /** CA-01: whether the agent may read secret-looking files (.env, keys) in it. */
  repoReadSecrets: boolean;
  /** CA-04: the mode its coding runs start in. */
  runMode: "plan" | "ask" | "auto_edit";
  /** M10 step 11: the cap and time limits its runs start with; null means FUSE's default. */
  runLimits: RunLimits;
  /** LL-01: sums, conversions and checks are answered without a model, at $0. */
  answerWithoutModel: boolean;
  createdAt: number;
  updatedAt: number;
}

export type PrivacyMode = "normal" | "local_only" | "cloud_only";

/** M10 step 11: what a project's runs may spend and how long they may take. Null: the default. */
export interface RunLimits {
  capMicroUsd: number | null;
  /** Active minutes a run may take in all. */
  wallMinutes: number | null;
  /** Active minutes a run may go without progress. */
  idleMinutes: number | null;
}

interface ProjectRow {
  id: string;
  name: string;
  instructions: string;
  default_provider: string | null;
  default_model: string | null;
  default_tier: "balanced" | "best" | null;
  privacy_mode: PrivacyMode;
  allow_embeddings: number;
  repo_root: string | null;
  repo_read_sensitive: number;
  run_mode: "plan" | "ask" | "auto_edit";
  run_cap_micro_usd: number | null;
  run_wall_minutes: number | null;
  run_idle_minutes: number | null;
  answer_without_model: number;
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
  privacyMode: r.privacy_mode,
  allowEmbeddings: r.allow_embeddings === 1,
  repoRoot: r.repo_root,
  repoReadSecrets: r.repo_read_sensitive === 1,
  runMode: r.run_mode,
  runLimits: {
    capMicroUsd: r.run_cap_micro_usd,
    wallMinutes: r.run_wall_minutes,
    idleMinutes: r.run_idle_minutes,
  },
  answerWithoutModel: r.answer_without_model === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** WF-02: the project's first linked folder stands in for its M6 repository. */
const FIRST_FOLDER = (col: "path" | "read_sensitive") =>
  `(SELECT f.${col} FROM project_folders pf JOIN folders f ON f.id = pf.folder_id
    WHERE pf.project_id = projects.id ORDER BY pf.created_at, pf.id LIMIT 1)`;

const COLUMNS = `id, name, instructions, default_provider, default_model, default_tier, privacy_mode,
  allow_embeddings, ${FIRST_FOLDER("path")} AS repo_root,
  COALESCE(${FIRST_FOLDER("read_sensitive")}, 0) AS repo_read_sensitive, run_mode,
  run_cap_micro_usd, run_wall_minutes, run_idle_minutes, answer_without_model, created_at,
  updated_at`;

/** SE-13: a project's privacy mode and whether it may be embedded. */
export async function setProjectPrivacy(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  privacy: { mode: PrivacyMode; allowEmbeddings: boolean },
): Promise<void> {
  await db.execute(
    `UPDATE projects SET privacy_mode = ?, allow_embeddings = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [privacy.mode, privacy.allowEmbeddings ? 1 : 0, Date.now(), tenant.workspaceId, id],
  );
}

/**
 * CA-01, WF-02: make `root` (already resolved by Rust's `repo_check`) the project's linked
 * folder, or unlink it with null. The folder stays granted; unlinking turns secret reading off.
 * Several folders per project come in M8 step 2; until then this keeps one.
 */
export async function setProjectRepo(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  repo: { root: string | null; readSecrets: boolean },
): Promise<void> {
  const current = await listProjectFolders(db, tenant, id);
  for (const f of current) {
    if (f.path !== repo.root) await unlinkProjectFolder(db, tenant, id, f.id);
  }
  if (repo.root) {
    const folder = await grantFolder(db, tenant, repo.root, repo.readSecrets);
    await linkProjectFolder(db, tenant, id, folder.id);
  } else {
    for (const f of current) await grantFolder(db, tenant, f.path, false);
  }
  await db.execute("UPDATE projects SET updated_at = ? WHERE workspace_id = ? AND id = ?", [
    Date.now(),
    tenant.workspaceId,
    id,
  ]);
}

/** CA-04: the mode the project's coding runs start in. */
export async function setProjectRunMode(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  mode: Project["runMode"],
): Promise<void> {
  await db.execute(
    "UPDATE projects SET run_mode = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    [mode, Date.now(), tenant.workspaceId, id],
  );
}

/**
 * M10 step 11: the cap and time limits the project's runs start with. A field left out of the
 * patch is kept; null puts it back on FUSE's default.
 */
export async function setProjectRunLimits(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  patch: Partial<RunLimits>,
): Promise<void> {
  const sets: string[] = [];
  const args: (number | null)[] = [];
  const cols: [keyof RunLimits, string][] = [
    ["capMicroUsd", "run_cap_micro_usd"],
    ["wallMinutes", "run_wall_minutes"],
    ["idleMinutes", "run_idle_minutes"],
  ];
  for (const [key, col] of cols) {
    if (key in patch) {
      sets.push(`${col} = ?`);
      args.push(patch[key] ?? null);
    }
  }
  if (sets.length === 0) return;
  await db.execute(
    `UPDATE projects SET ${sets.join(", ")}, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    [...args, Date.now(), tenant.workspaceId, id],
  );
}

/** LL-01: whether the project answers simple questions without a model. */
export async function setProjectAnswerWithoutModel(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  on: boolean,
): Promise<void> {
  await db.execute(
    "UPDATE projects SET answer_without_model = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    [on ? 1 : 0, Date.now(), tenant.workspaceId, id],
  );
}

/** Commands the project's runs may run without asking (exact match; destructive ones still ask). */
export async function listAllowedCommands(
  db: SqlDb,
  tenant: Tenant,
  projectId: string,
): Promise<string[]> {
  const rows = await db.select<{ command: string }>(
    `SELECT command FROM project_commands WHERE workspace_id = ? AND project_id = ?
     ORDER BY command`,
    [tenant.workspaceId, projectId],
  );
  return rows.map((r) => r.command);
}

export async function allowCommand(
  db: SqlDb,
  tenant: Tenant,
  projectId: string,
  command: string,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO project_commands (id, workspace_id, user_id, project_id, command, created_at,
       updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, command) DO NOTHING`,
    [uuidv7(now), tenant.workspaceId, tenant.userId, projectId, command.trim(), now, now],
  );
}

export async function disallowCommand(
  db: SqlDb,
  tenant: Tenant,
  projectId: string,
  command: string,
): Promise<void> {
  await db.execute(
    "DELETE FROM project_commands WHERE workspace_id = ? AND project_id = ? AND command = ?",
    [tenant.workspaceId, projectId, command],
  );
}

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
  // The project's saved prompts (CH-12) aren't lost: they move to every chat.
  await db.execute(
    `UPDATE prompts SET project_id = NULL, updated_at = ? WHERE workspace_id = ? AND project_id = ?`,
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
