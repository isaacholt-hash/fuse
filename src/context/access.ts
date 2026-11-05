/** One live scope for app-managed context tools. Callers supply identity, never model input. */
import type { ProviderId } from "@/catalog/catalog";
import type { Tenant } from "@/storage/defaults";
import type { SqlDb, SqlValue } from "@/storage/sql";

export interface ContextOwner {
  threadId: string;
  projectId: string | null;
  runId: string | null;
  messageId: string | null;
  provider: ProviderId;
  model: string;
  /** Unique provider tool turn, scoped by the caller's message/run rather than arbitrary input. */
  callKey: string;
}
export interface ContextDb {
  db: SqlDb;
  tenant: Tenant;
}
export interface ContextGuard {
  sql: string;
  params: SqlValue[];
}

/** Reused inside mutation batches, so deletion, revocation and a competing owner cannot race a write. */
export function contextGuard(
  { tenant }: ContextDb,
  owner: ContextOwner,
  tool: string,
  memory = false,
  write = false,
): ContextGuard {
  const sql = `EXISTS(SELECT 1 FROM threads t
    LEFT JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id AND p.user_id=t.user_id
    WHERE t.workspace_id=? AND t.user_id=? AND t.id=? AND t.project_id IS ?
      AND t.deleted_at IS NULL AND t.incognito=0 AND t.local_only=0
      ${memory ? "AND t.memory_injection='on'" : ""}
      AND (t.project_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL AND p.privacy_mode!='local_only'))
      AND COALESCE((SELECT allow FROM egress_rules e WHERE e.workspace_id=t.workspace_id AND e.user_id=t.user_id AND e.project_id=t.project_id AND e.provider=?),
                   (SELECT allow FROM egress_rules e WHERE e.workspace_id=t.workspace_id AND e.user_id=t.user_id AND e.project_id IS NULL AND e.provider=?),1)=1
      AND NOT EXISTS(SELECT 1 FROM project_tools_off o WHERE o.workspace_id=t.workspace_id AND o.user_id=t.user_id AND o.project_id=t.project_id AND o.tool=?)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM runs r WHERE r.workspace_id=t.workspace_id AND r.user_id=t.user_id AND r.id=?
        AND r.thread_id=t.id AND r.project_id IS t.project_id AND r.status='running'
        ${write ? "AND r.mode!='plan' AND r.review_profile=0" : ""}
        AND (r.sync_owner IS NULL OR r.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=r.workspace_id))
        AND (r.parent_run_id IS NULL OR EXISTS(SELECT 1 FROM runs parent WHERE parent.workspace_id=r.workspace_id AND parent.user_id=r.user_id
          AND parent.id=r.parent_run_id AND parent.parent_run_id IS NULL AND parent.status='running'
          AND parent.project_id IS r.project_id AND parent.thread_id IS r.thread_id
          AND (parent.sync_owner IS NULL OR parent.sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=parent.workspace_id))))))
    )`;
  return {
    sql,
    params: [
      tenant.workspaceId,
      tenant.userId,
      owner.threadId,
      owner.projectId,
      owner.provider,
      owner.provider,
      tool,
      owner.runId,
      owner.runId,
    ],
  };
}

export async function requireContext(
  deps: ContextDb,
  owner: ContextOwner,
  tool: string,
  memory = false,
  write = false,
): Promise<ContextGuard> {
  if (owner.provider === "local") throw new Error("Local models are restricted to housekeeping.");
  if (!owner.callKey || owner.callKey.length > 512)
    throw new Error("Invalid context-tool turn identity.");
  const guard = contextGuard(deps, owner, tool, memory, write);
  const rows = await deps.db.select<{ allowed: number }>(
    `SELECT ${guard.sql} AS allowed`,
    guard.params,
  );
  if (rows[0]?.allowed !== 1)
    throw new Error(
      "This conversation, execution owner or privacy/tool setting changed. Refresh and review its settings before continuing.",
    );
  return guard;
}

export interface ScopedArtifact {
  id: string;
  key: string;
  title: string;
  type: string;
  language: string;
  threadId: string;
  threadTitle: string;
  projectId: string | null;
  versionId: string;
  content: string;
  totalCharacters: number;
  source: string;
  messageId: string | null;
  updatedAt: number;
}

/** Only current versions in this conversation/project; private or deleted sources never enter ranking. */
export async function scopedArtifacts(
  deps: ContextDb,
  owner: ContextOwner,
  { id, keywords, limit = 200 }: { id?: string; keywords?: readonly string[]; limit?: number } = {},
): Promise<ScopedArtifact[]> {
  const { tenant, db } = deps;
  const terms = (keywords ?? []).slice(0, 12);
  const rows = await db.select<ScopedArtifact>(
    `SELECT a.id,a.key,a.title,a.type,a.language,a.thread_id AS threadId,t.title AS threadTitle,t.project_id AS projectId,
      v.id AS versionId,SUBSTR(v.content,1,100001) AS content,LENGTH(v.content) AS totalCharacters,v.source,v.message_id AS messageId,a.updated_at AS updatedAt
     FROM artifacts a JOIN threads t ON t.id=a.thread_id AND t.workspace_id=a.workspace_id AND t.user_id=a.user_id
     JOIN artifact_versions v ON v.artifact_id=a.id AND v.workspace_id=a.workspace_id AND v.user_id=a.user_id
       AND v.id=(SELECT id FROM artifact_versions WHERE artifact_id=a.id AND workspace_id=a.workspace_id AND user_id=a.user_id ORDER BY version DESC,id DESC LIMIT 1)
     WHERE a.workspace_id=? AND a.user_id=? AND a.deleted_at IS NULL AND t.deleted_at IS NULL AND t.incognito=0 AND t.local_only=0
       AND (t.id=? OR (? IS NOT NULL AND t.project_id=?))
       ${id ? "AND a.id=?" : ""}
       ${terms.map(() => "AND (a.title LIKE ? ESCAPE '\\' OR v.content LIKE ? ESCAPE '\\')").join(" ")}
     ORDER BY a.updated_at DESC,a.id DESC LIMIT ?`,
    [
      tenant.workspaceId,
      tenant.userId,
      owner.threadId,
      owner.projectId,
      owner.projectId,
      ...(id ? [id] : []),
      ...terms.flatMap((term) => {
        const text = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
        return [text, text];
      }),
      Math.min(Math.max(limit, 1), 200),
    ],
  );
  return rows;
}
