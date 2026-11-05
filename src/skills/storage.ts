import type { Tenant } from "@/storage/defaults";
import { uuidv7 } from "@/storage/ids";
import type { SqlDb } from "@/storage/sql";
import { skillName, verifySkillPackage, type SkillPackage } from "./package";

export interface SkillView {
  id: string;
  name: string;
  projectId: string | null;
  localOnly: boolean;
  versionId: string;
  versions: number;
  sha256: string;
  source: string;
  createdAt: number;
}

export async function listSkills(db: SqlDb, tenant: Tenant): Promise<SkillView[]> {
  const rows = await db.select<{
    id: string;
    name: string;
    project_id: string | null;
    sync_local_only: number;
    version_id: string;
    versions: number;
    sha256: string;
    source: string;
    created_at: number;
  }>(
    `SELECT s.id,s.name,s.project_id,s.sync_local_only,v.id AS version_id,
      (SELECT COUNT(*) FROM skill_versions sv WHERE sv.skill_id=s.id AND sv.workspace_id=s.workspace_id) AS versions,
      v.sha256,v.source,v.created_at FROM skills s JOIN skill_versions v ON v.skill_id=s.id
      AND v.workspace_id=s.workspace_id AND v.user_id=s.user_id
      WHERE s.workspace_id=? AND s.user_id=? AND v.id=(SELECT id FROM skill_versions
        WHERE skill_id=s.id AND workspace_id=s.workspace_id ORDER BY created_at DESC,id DESC LIMIT 1)
      AND (s.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=s.project_id AND p.workspace_id=s.workspace_id AND p.deleted_at IS NULL))
      ORDER BY s.name,s.id`,
    [tenant.workspaceId, tenant.userId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    projectId: r.project_id,
    localOnly: r.sync_local_only === 1,
    versionId: r.version_id,
    versions: r.versions,
    sha256: r.sha256,
    source: r.source,
    createdAt: r.created_at,
  }));
}

/** The preview must be confirmed. Adding a version never overwrites the selected version. */
export async function importSkill(
  db: SqlDb,
  tenant: Tenant,
  input: {
    name: string;
    projectId: string | null;
    localOnly: boolean;
    package: SkillPackage;
    skillId?: string;
  },
): Promise<{ skillId: string; versionId: string }> {
  const name = skillName(input.name);
  const pkg = await verifySkillPackage(input.package);
  if (input.projectId) {
    const [p] = await db.select<{ id: string }>(
      "SELECT id FROM projects WHERE id=? AND workspace_id=? AND user_id=? AND deleted_at IS NULL",
      [input.projectId, tenant.workspaceId, tenant.userId],
    );
    if (!p) throw new Error("The skill's project is no longer available.");
  }
  const existing = input.skillId
    ? (await listSkills(db, tenant)).find((s) => s.id === input.skillId)
    : null;
  if (
    input.skillId &&
    (!existing ||
      existing.name !== name ||
      existing.projectId !== input.projectId ||
      existing.localOnly !== input.localOnly)
  )
    throw new Error("The selected skill's scope changed. Review the import again.");
  const now = Date.now(),
    id = existing?.id ?? uuidv7(now),
    versionId = uuidv7(now);
  await db.batch([
    ...(!existing
      ? [
          {
            sql: `INSERT INTO skills(id,workspace_id,user_id,project_id,name,sync_local_only,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`,
            params: [
              id,
              tenant.workspaceId,
              tenant.userId,
              input.projectId,
              name,
              input.localOnly ? 1 : 0,
              now,
              now,
            ],
          },
        ]
      : []),
    {
      sql: `INSERT INTO skill_versions(id,workspace_id,user_id,skill_id,instructions,assets,sha256,source,created_at,updated_at)
      VALUES (?,?,?,(SELECT id FROM skills WHERE id=? AND workspace_id=? AND user_id=?
      AND (project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=skills.project_id AND p.workspace_id=skills.workspace_id AND p.deleted_at IS NULL))),?,?,?,?,?,?)`,
      params: [
        versionId,
        tenant.workspaceId,
        tenant.userId,
        id,
        tenant.workspaceId,
        tenant.userId,
        pkg.instructions,
        JSON.stringify(pkg.assets),
        pkg.sha256,
        pkg.source,
        now,
        now,
      ],
    },
  ]);
  const [saved] = await db.select<{ id: string }>(
    "SELECT id FROM skill_versions WHERE id=? AND workspace_id=?",
    [versionId, tenant.workspaceId],
  );
  if (!saved) throw new Error("The skill was deleted during import; no version was installed.");
  return { skillId: id, versionId };
}

export async function deleteSkill(db: SqlDb, tenant: Tenant, id: string): Promise<void> {
  await db.batch([
    {
      sql: "DELETE FROM skill_versions WHERE skill_id=? AND workspace_id=? AND user_id=?",
      params: [id, tenant.workspaceId, tenant.userId],
    },
    {
      sql: "DELETE FROM skills WHERE id=? AND workspace_id=? AND user_id=?",
      params: [id, tenant.workspaceId, tenant.userId],
    },
  ]);
}

export async function getSkillVersion(
  db: SqlDb,
  tenant: Tenant,
  versionId: string,
  projectId: string | null,
): Promise<SkillPackage & { name: string; skillId: string; versionId: string }> {
  const [r] = await db.select<{
    name: string;
    skill_id: string;
    instructions: string;
    assets: string;
    sha256: string;
    source: string;
  }>(
    `SELECT s.name,v.skill_id,v.instructions,v.assets,v.sha256,v.source FROM skill_versions v
    JOIN skills s ON s.id=v.skill_id AND s.workspace_id=v.workspace_id AND s.user_id=v.user_id
    WHERE v.id=? AND v.workspace_id=? AND v.user_id=? AND (s.project_id IS NULL OR s.project_id=?)
    AND (s.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=s.project_id AND p.workspace_id=s.workspace_id AND p.deleted_at IS NULL))`,
    [versionId, tenant.workspaceId, tenant.userId, projectId],
  );
  if (!r)
    throw new Error(
      "That skill version isn't available in this project on this installation. Import it here or wait for enrolled sync.",
    );
  const pkg = await verifySkillPackage({
    instructions: r.instructions,
    assets: JSON.parse(r.assets) as SkillPackage["assets"],
    sha256: r.sha256,
    source: r.source,
  });
  return { ...pkg, name: skillName(r.name), skillId: r.skill_id, versionId };
}
