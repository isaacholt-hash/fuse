/** Artifacts and their versions (AR-01, AR-02). */
import type { ArtifactBlock, ArtifactType } from "@/artifacts/parse";
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export interface Artifact {
  id: string;
  key: string;
  title: string;
  type: ArtifactType;
  language: string;
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
    version: number;
    content: string;
    source: Artifact["source"];
    updated_at: number;
    allow_cdn: number;
  }>(
    `SELECT a.id, a.key, a.title, a.type, a.language, v.version, v.content, v.source, a.updated_at,
            a.allow_cdn
     FROM artifacts a
     JOIN artifact_versions v ON v.artifact_id = a.id
       AND v.version = (SELECT MAX(version) FROM artifact_versions WHERE artifact_id = a.id)
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
  const rows = await db.select<{
    id: string;
    version: number;
    content: string;
    source: ArtifactVersion["source"];
    message_id: string | null;
    created_at: number;
  }>(
    `SELECT id, version, content, source, message_id, created_at FROM artifact_versions
     WHERE workspace_id = ? AND artifact_id = ? ORDER BY version`,
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

/** Adds a version if the content changed; returns the version number now current. */
export async function addVersion(
  db: SqlDb,
  tenant: Tenant,
  artifactId: string,
  content: string,
  source: ArtifactVersion["source"],
  messageId: string | null = null,
): Promise<number> {
  const latest = await db.select<{ version: number; content: string }>(
    `SELECT version, content FROM artifact_versions WHERE workspace_id = ? AND artifact_id = ?
     ORDER BY version DESC LIMIT 1`,
    [tenant.workspaceId, artifactId],
  );
  const top = latest[0];
  if (top && top.content === content) return top.version;
  const now = Date.now();
  const version = (top?.version ?? 0) + 1;
  await db.execute(
    `INSERT INTO artifact_versions (id, workspace_id, user_id, artifact_id, version, content,
       source, message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv7(now),
      tenant.workspaceId,
      tenant.userId,
      artifactId,
      version,
      content,
      source,
      messageId,
      now,
      now,
    ],
  );
  await db.execute(`UPDATE artifacts SET updated_at = ? WHERE workspace_id = ? AND id = ?`, [
    now,
    tenant.workspaceId,
    artifactId,
  ]);
  return version;
}

/** Saves an answer's finished artifacts: new ones, or a new version of one with the same key. */
export async function saveArtifacts(
  db: SqlDb,
  tenant: Tenant,
  threadId: string,
  messageId: string,
  blocks: readonly ArtifactBlock[],
): Promise<void> {
  for (const b of blocks) {
    const found = await db.select<{ id: string }>(
      `SELECT id FROM artifacts WHERE workspace_id = ? AND thread_id = ? AND key = ?`,
      [tenant.workspaceId, threadId, b.key],
    );
    let id = found[0]?.id;
    const now = Date.now();
    if (id) {
      await db.execute(
        `UPDATE artifacts SET title = ?, type = ?, language = ?, deleted_at = NULL, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
        [b.title, b.type, b.language, now, tenant.workspaceId, id],
      );
    } else {
      id = uuidv7(now);
      await db.execute(
        `INSERT INTO artifacts (id, workspace_id, user_id, thread_id, key, title, type, language,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          tenant.workspaceId,
          tenant.userId,
          threadId,
          b.key,
          b.title,
          b.type,
          b.language,
          now,
          now,
        ],
      );
    }
    await addVersion(db, tenant, id, b.content, "model", messageId);
  }
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
    AND v.version = (SELECT MAX(version) FROM artifact_versions WHERE artifact_id = a.id)
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
