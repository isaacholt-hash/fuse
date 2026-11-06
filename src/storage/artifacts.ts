/** Artifacts and their versions (AR-01, AR-02). */
import { resolveArtifactId } from "@/sync/aliases";
import type { ArtifactBlock, ArtifactType } from "@/artifacts/parse";
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import {
  artifactBasis,
  publicationWrites,
  versionInsert,
  type ArtifactBasis,
} from "./artifactWrites";
import type { SqlDb } from "./sql";

export interface Artifact {
  id: string;
  key: string;
  title: string;
  type: ArtifactType;
  language: string;
  /** The authoritative latest UUID, separate from its displayed number. */
  versionId: string;
  /** The latest version. */
  version: number;
  content: string;
  /** Who made the latest version: an edit by you means the model hasn't seen it yet. */
  source: "model" | "user" | "restore";
  updatedAt: number;
  /** AR-05: the preview may load the listed CDNs. */
  allowCdn: boolean;
}

export interface ArtifactVersion {
  id: string;
  version: number;
  content: string;
  source: "model" | "user" | "restore";
  messageId: string | null;
  createdAt: number;
}

/** A thread's artifacts with their latest content, oldest first. */
export async function listArtifacts(
  db: SqlDb,
  tenant: Tenant,
  threadId: string,
): Promise<Artifact[]> {
  const rows = await db.select<{
    id: string;
    key: string;
    title: string;
    type: ArtifactType;
    language: string;
    version_id: string;
    version: number;
    content: string;
    source: Artifact["source"];
    updated_at: number;
    allow_cdn: number;
  }>(
    `SELECT a.id, a.key, a.title, a.type, a.language, v.id AS version_id, (SELECT COUNT(*) FROM artifact_versions n WHERE n.artifact_id=a.id) AS version, v.content, v.source, a.updated_at,
            a.allow_cdn
     FROM artifacts a
     JOIN artifact_versions v ON v.artifact_id = a.id
       AND v.id = (SELECT id FROM artifact_versions WHERE artifact_id = a.id ORDER BY version DESC,id DESC LIMIT 1)
     WHERE a.workspace_id = ? AND a.thread_id = ? AND a.deleted_at IS NULL
     ORDER BY a.created_at`,
    [tenant.workspaceId, threadId],
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    title: r.title,
    type: r.type,
    language: r.language,
    versionId: r.version_id,
    version: r.version,
    content: r.content,
    source: r.source,
    updatedAt: r.updated_at,
    allowCdn: r.allow_cdn === 1,
  }));
}

/** Lets an artifact's preview load the listed CDNs, or not (AR-05). */
export async function setArtifactCdn(
  db: SqlDb,
  tenant: Tenant,
  id: string,
  allow: boolean,
): Promise<void> {
  id = await resolveArtifactId(db, tenant, id);
  await db.execute(`UPDATE artifacts SET allow_cdn = ? WHERE workspace_id = ? AND id = ?`, [
    allow ? 1 : 0,
    tenant.workspaceId,
    id,
  ]);
}

export async function listVersions(
  db: SqlDb,
  tenant: Tenant,
  artifactId: string,
): Promise<ArtifactVersion[]> {
  artifactId = await resolveArtifactId(db, tenant, artifactId);
  const rows = await db.select<{
    id: string;
    version: number;
    content: string;
    source: ArtifactVersion["source"];
    message_id: string | null;
    created_at: number;
  }>(
    `SELECT id, ROW_NUMBER() OVER (ORDER BY version,id) AS version, content, source, message_id, created_at FROM artifact_versions
     WHERE workspace_id = ? AND artifact_id = ? ORDER BY version,id`,
    [tenant.workspaceId, artifactId],
  );
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    content: r.content,
    source: r.source,
    messageId: r.message_id,
    createdAt: r.created_at,
  }));
}

async function versionCount(db: SqlDb, tenant: Tenant, artifactId: string): Promise<number> {
  const rows = await db.select<{ n: number }>(
    "SELECT COUNT(*) AS n FROM artifact_versions WHERE workspace_id=? AND artifact_id=?",
    [tenant.workspaceId, artifactId],
  );
  return rows[0]?.n ?? 0;
}

/** Adds a version if the content changed; returns the version number now current. */
export async function addVersion(
  db: SqlDb,
  tenant: Tenant,
  artifactId: string,
  content: string,
  source: ArtifactVersion["source"],
  messageId: string | null = null,
  expectedVersionId?: string,
): Promise<number> {
  artifactId = await resolveArtifactId(db, tenant, artifactId);
  const [top] = await db.select<{ id: string; content: string }>(
    `SELECT id,content FROM artifact_versions WHERE workspace_id=? AND user_id=? AND artifact_id=? ORDER BY version DESC,id DESC LIMIT 1`,
    [tenant.workspaceId, tenant.userId, artifactId],
  );
  const base = expectedVersionId ?? top?.id ?? null;
  if (base !== top?.id)
    throw new Error(
      "The artifact changed. Your draft is preserved; compare it with the latest version.",
    );
  if (top.content === content) return versionCount(db, tenant, artifactId);
  const now = Date.now(),
    id = uuidv7();
  const result = await db.batch([
    versionInsert(tenant, { id, artifactId, baseId: base, content, source, messageId, now }),
    {
      sql: "UPDATE artifacts SET updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND EXISTS(SELECT 1 FROM artifact_versions WHERE id=?)",
      params: [now, tenant.workspaceId, tenant.userId, artifactId, id],
    },
  ]);
  if (result[0]?.rowsAffected !== 1)
    throw new Error(
      "The artifact changed or was deleted. Your draft is preserved; refresh and compare before saving.",
    );
  return versionCount(db, tenant, artifactId);
}

/** Saves an answer's finished artifacts: new ones, or a new version of one with the same key. */
export async function saveArtifacts(
  db: SqlDb,
  tenant: Tenant,
  threadId: string,
  messageId: string,
  blocks: readonly ArtifactBlock[],
  basis?: readonly ArtifactBasis[],
): Promise<void> {
  await db.batch(
    publicationWrites(
      tenant,
      threadId,
      messageId,
      blocks,
      basis ?? (await artifactBasis(db, tenant, threadId)),
    ),
  );
}

export interface ArtifactHit {
  id: string;
  key: string;
  title: string;
  threadId: string;
  threadTitle: string;
  projectId: string | null;
  /** The latest version. */
  content: string;
  updatedAt: number;
}

const ARTIFACT_HIT = `
  SELECT a.id, a.key, a.title, a.thread_id, t.title AS thread_title, t.project_id, v.content,
         a.updated_at
  FROM artifacts a
  JOIN threads t ON t.id = a.thread_id AND t.deleted_at IS NULL AND t.incognito = 0
  JOIN artifact_versions v ON v.artifact_id = a.id
    AND v.id = (SELECT id FROM artifact_versions WHERE artifact_id = a.id ORDER BY version DESC,id DESC LIMIT 1)
  WHERE a.workspace_id = ? AND a.deleted_at IS NULL`;

interface ArtifactHitRow {
  id: string;
  key: string;
  title: string;
  thread_id: string;
  thread_title: string;
  project_id: string | null;
  content: string;
  updated_at: number;
}

const toHit = (r: ArtifactHitRow): ArtifactHit => ({
  id: r.id,
  key: r.key,
  title: r.title,
  threadId: r.thread_id,
  threadTitle: r.thread_title,
  projectId: r.project_id,
  content: r.content,
  updatedAt: r.updated_at,
});

/** AR-06: artifacts whose title or latest version has every word, newest first. */
export async function searchArtifacts(
  db: SqlDb,
  tenant: Tenant,
  text: string,
  limit = 5,
): Promise<ArtifactHit[]> {
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (words.length === 0) return [];
  const like = (w: string) => `%${w.replace(/[%_\\]/g, "")}%`;
  const rows = await db.select<ArtifactHitRow>(
    `${ARTIFACT_HIT} ${words.map(() => "AND (a.title LIKE ? OR v.content LIKE ?)").join(" ")}
     ORDER BY a.updated_at DESC LIMIT ?`,
    [tenant.workspaceId, ...words.flatMap((w) => [like(w), like(w)]), limit],
  );
  return rows.map(toHit);
}

/** AR-06: the artifacts made in a project's chats, newest first. */
export async function projectArtifacts(
  db: SqlDb,
  tenant: Tenant,
  projectId: string,
): Promise<ArtifactHit[]> {
  const rows = await db.select<ArtifactHitRow>(
    `${ARTIFACT_HIT} AND t.project_id = ? ORDER BY a.updated_at DESC`,
    [tenant.workspaceId, projectId],
  );
  return rows.map(toHit);
}
