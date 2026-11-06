/** Shared compare-and-swap boundary for local edits, tool writes and completed replies. */
import type { ArtifactBlock } from "@/artifacts/parse";
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb, SqlStatement, SqlValue } from "./sql";
export interface ArtifactBasis {
  id: string;
  key: string;
  versionId: string | null;
  deleted: boolean;
}
export async function artifactBasis(
  db: SqlDb,
  t: Tenant,
  threadId: string,
): Promise<ArtifactBasis[]> {
  const rows = await db.select<{
    id: string;
    key: string;
    version_id: string | null;
    deleted_at: number | null;
  }>(
    `SELECT a.id,a.key,a.deleted_at,(SELECT id FROM artifact_versions WHERE artifact_id=a.id ORDER BY version DESC,id DESC LIMIT 1) AS version_id FROM artifacts a WHERE a.workspace_id=? AND a.user_id=? AND a.thread_id=?`,
    [t.workspaceId, t.userId, threadId],
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    versionId: r.version_id,
    deleted: r.deleted_at !== null,
  }));
}
export function versionInsert(
  t: Tenant,
  p: {
    id: string;
    artifactId: string;
    baseId: string | null;
    content: string;
    source: "model" | "user" | "restore";
    messageId: string | null;
    now: number;
    guard?: string;
    params?: SqlValue[];
  },
): SqlStatement {
  return {
    sql: `INSERT INTO artifact_versions(id,workspace_id,user_id,artifact_id,version,content,source,message_id,created_at,updated_at)
 SELECT ?,?,?,a.id,COALESCE((SELECT MAX(version) FROM artifact_versions WHERE artifact_id=a.id),0)+1,?,?,?,?,?
 FROM artifacts a JOIN threads t ON t.id=a.thread_id AND t.workspace_id=a.workspace_id AND t.user_id=a.user_id
 WHERE a.workspace_id=? AND a.user_id=? AND a.id=? AND a.deleted_at IS NULL AND t.deleted_at IS NULL
 AND (SELECT id FROM artifact_versions WHERE artifact_id=a.id ORDER BY version DESC,id DESC LIMIT 1) IS ? AND (${p.guard ?? "1"})`,
    params: [
      p.id,
      t.workspaceId,
      t.userId,
      p.content,
      p.source,
      p.messageId,
      p.now,
      p.now,
      t.workspaceId,
      t.userId,
      p.artifactId,
      p.baseId,
      ...(p.params ?? []),
    ],
  };
}
export function publicationWrites(
  t: Tenant,
  threadId: string,
  messageId: string,
  blocks: readonly ArtifactBlock[],
  basis: readonly ArtifactBasis[],
  guard = "1",
  params: SqlValue[] = [],
): SqlStatement[] {
  const writes: SqlStatement[] = [];
  for (const b of blocks) {
    const start = basis.find((a) => a.key === b.key);
    const id = start?.id ?? uuidv7();
    const versionId = uuidv7();
    const now = Date.now();
    if (!start)
      writes.push({
        sql: `INSERT INTO artifacts(id,workspace_id,user_id,thread_id,key,title,type,language,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE (${guard}) AND EXISTS(SELECT 1 FROM threads WHERE id=? AND workspace_id=? AND user_id=? AND deleted_at IS NULL) ON CONFLICT(workspace_id,thread_id,key) DO NOTHING`,
        params: [
          id,
          t.workspaceId,
          t.userId,
          threadId,
          b.key,
          b.title,
          b.type,
          b.language,
          now,
          now,
          ...params,
          threadId,
          t.workspaceId,
          t.userId,
        ],
      });
    writes.push(
      versionInsert(t, {
        id: versionId,
        artifactId: id,
        baseId: start?.versionId ?? null,
        content: b.content,
        source: "model",
        messageId,
        now,
        guard: `(${guard}) AND ${start?.deleted ? "0" : "1"} AND (SELECT content FROM artifact_versions WHERE artifact_id=a.id ORDER BY version DESC,id DESC LIMIT 1) IS NOT ?`,
        params: [...params, b.content],
      }),
    );
    writes.push({
      sql: `UPDATE artifacts SET title=?,type=?,language=?,updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM artifact_versions WHERE id=?)`,
      params: [b.title, b.type, b.language, now, t.workspaceId, t.userId, id, versionId],
    });
    // Losing candidates stay inert and visible in the canvas, never become a new current version.
    writes.push({
      sql: `INSERT INTO artifact_proposals(id,workspace_id,user_id,artifact_id,base_version_id,message_id,anchor_start,anchor_end,instruction,content,state,created_at,updated_at)
 SELECT ?,?,?,a.id,?,?,0,0,'Concurrent reply: review before saving',?,'pending',?,? FROM artifacts a
 WHERE a.workspace_id=? AND a.user_id=? AND a.thread_id=? AND a.key=? AND a.deleted_at IS NULL AND (${guard})
 AND NOT EXISTS(SELECT 1 FROM artifact_versions WHERE id=?) AND (SELECT content FROM artifact_versions WHERE artifact_id=a.id ORDER BY version DESC,id DESC LIMIT 1) IS NOT ?
 AND NOT EXISTS(SELECT 1 FROM artifact_proposals WHERE workspace_id=? AND user_id=? AND artifact_id=a.id AND message_id=? AND content=? AND instruction='Concurrent reply: review before saving')`,
      params: [
        uuidv7(),
        t.workspaceId,
        t.userId,
        start?.versionId ?? null,
        messageId,
        b.content,
        now,
        now,
        t.workspaceId,
        t.userId,
        threadId,
        b.key,
        ...params,
        versionId,
        b.content,
        t.workspaceId,
        t.userId,
        messageId,
        b.content,
      ],
    });
  }
  return writes;
}
