/** App memory is read in scope; model mutations are inert suggestions until owner review. */
import { inScope, keywords } from "@/memory/inject";
import { findSecret } from "@/memory/secrets";
import { listMemories, MAX_MEMORY_CHARS, type Memory } from "@/storage/memories";
import { uuidv7 } from "@/storage/ids";
import type { ProviderId } from "@/catalog/catalog";
import type { ContextDb, ContextOwner } from "./access";
import { requireContext } from "./access";

export async function scopedMemories(
  deps: ContextDb,
  owner: { projectId: string | null; threadId: string | null; provider: ProviderId },
): Promise<Memory[]> {
  const ids = await deps.db.select<{ id: string }>(
    `SELECT m.id FROM memories m LEFT JOIN threads s ON s.id=m.source_thread_id AND s.workspace_id=m.workspace_id AND s.user_id=m.user_id
     LEFT JOIN projects p ON p.id=s.project_id AND p.workspace_id=s.workspace_id AND p.user_id=s.user_id
     WHERE m.workspace_id=? AND m.user_id=? AND m.may_send=1
       AND (m.source_thread_id IS NULL OR (s.id IS NOT NULL AND s.deleted_at IS NULL AND s.incognito=0 AND s.local_only=0
         AND (s.project_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL AND p.privacy_mode!='local_only'))
         AND COALESCE((SELECT allow FROM egress_rules e WHERE e.workspace_id=m.workspace_id AND e.user_id=m.user_id AND e.project_id=s.project_id AND e.provider=?),
                      (SELECT allow FROM egress_rules e WHERE e.workspace_id=m.workspace_id AND e.user_id=m.user_id AND e.project_id IS NULL AND e.provider=?),1)=1))`,
    [deps.tenant.workspaceId, deps.tenant.userId, owner.provider, owner.provider],
  );
  const allowed = new Set(ids.map((x) => x.id));
  return (await listMemories(deps.db, deps.tenant)).filter(
    (m) =>
      allowed.has(m.id) &&
      inScope(m, owner) &&
      !findSecret(
        [m.text, m.rationale ?? "", ...m.alternatives, m.sourceThreadTitle ?? ""].join("\n"),
      ),
  );
}

export async function readMemory(
  deps: ContextDb,
  owner: ContextOwner,
  input: Record<string, unknown>,
) {
  await requireContext(deps, owner, "read_memory", true);
  const pool = await scopedMemories(deps, owner);
  const query = typeof input.query === "string" ? input.query : "";
  if (query.length > 2000 || (typeof input.id === "string" && input.id.length > 128))
    throw new Error("Use a bounded memory query or ID.");
  const words = keywords(query);
  const matches = pool.filter(
    (m) =>
      (!input.id || m.id === input.id) &&
      (!words.size || [...words].some((w) => m.text.toLowerCase().includes(w))),
  );
  await requireContext(deps, owner, "read_memory", true);
  return {
    records: matches.slice(0, 20).map((m) => ({
      id: m.id,
      text: m.text,
      kind: m.kind,
      scope: m.scope,
      revision: m.revision,
      authority: m.authority,
      sourceThreadId: m.sourceThreadId,
      sourceThreadTitle: m.sourceThreadTitle,
      extractionModel: m.extractionModel,
      confidence: m.confidence,
      rationale: m.rationale,
      alternatives: m.alternatives,
      taskStatus: m.taskStatus,
      dependsOn: m.dependsOn,
    })),
    truncated: matches.length > 20,
    notice:
      "Saved active records only. Conflicting, private and expired records are excluded. Decisions can only be changed by the owner.",
  };
}

export async function proposeMemory(
  deps: ContextDb,
  owner: ContextOwner,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const guard = await requireContext(deps, owner, "propose_memory", true, true);
  const { db, tenant } = deps;
  const [receipt] = await db.select<{ result_id: string }>(
    "SELECT result_id FROM context_tool_audit WHERE workspace_id=? AND user_id=? AND call_key=? AND tool_name='propose_memory'",
    [tenant.workspaceId, tenant.userId, owner.callKey],
  );
  if (receipt) return { proposalId: receipt.result_id, status: "pending_review", repeated: true };
  const op = input.operation;
  if (op !== "add" && op !== "update" && op !== "delete")
    throw new Error("Choose add, update or delete.");
  const text = typeof input.text === "string" ? input.text.trim().replace(/\s+/g, " ") : "";
  if ((op !== "delete" && !text) || text.length > MAX_MEMORY_CHARS || findSecret(text))
    throw new Error("Use non-secret memory text of up to 500 characters.");
  const pool = await scopedMemories(deps, owner);
  const target = op !== "add" ? pool.find((m) => m.id === input.id) : null;
  if (
    op !== "add" &&
    (!target ||
      target.kind === "decision" ||
      !Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision !== target.revision)
  )
    throw new Error(
      "Read the current in-scope memory and provide its revision. Decisions require manual owner editing.",
    );
  // A project/conversation tool cannot propose changes to a wider, global memory.
  if (target && (target.scope === "global" || target.scope === "workspace"))
    throw new Error("Changes to global memories require the owner in Settings → Memory.");
  const kind = target?.kind ?? input.kind;
  if (!["fact", "preference", "person", "constraint", "task", "source"].includes(String(kind)))
    throw new Error("Models cannot create or supersede decisions.");
  const now = Date.now(),
    id = uuidv7(now);
  const targetGuard = target
    ? `AND EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=? AND m.user_id=? AND m.id=? AND m.revision=? AND m.status='active' AND m.may_send=1
    AND NOT EXISTS(SELECT 1 FROM sync_conflicts c WHERE c.workspace_id=m.workspace_id AND c.table_name='memories' AND c.record_key=m.id AND c.resolved_at IS NULL))`
    : "";
  if (signal?.aborted) throw new Error("Memory suggestion cancelled before saving.");
  const results = await db.batch([
    {
      sql: `INSERT INTO memory_proposals(id,workspace_id,user_id,op,memory_id,text,kind,project_id,confidence,source_thread_id,origin,extraction_model,
      created_at,updated_at,target_revision,thread_id,source_message_id,source_run_id)
      SELECT ?,?,?,?,?,?,?,?,75,?,'chat',?,?,?,?,?,?,? WHERE ${guard.sql} ${targetGuard}
      AND NOT EXISTS(SELECT 1 FROM context_tool_audit WHERE workspace_id=? AND user_id=? AND call_key=?)`,
      params: [
        id,
        tenant.workspaceId,
        tenant.userId,
        op,
        target?.id ?? null,
        text || target?.text || "",
        String(kind),
        target ? target.projectId : owner.projectId,
        owner.threadId,
        `${owner.provider}/${owner.model}`,
        now,
        now,
        target?.revision ?? null,
        target ? target.threadId : owner.threadId,
        owner.messageId,
        owner.runId,
        ...guard.params,
        ...(target ? [tenant.workspaceId, tenant.userId, target.id, target.revision] : []),
        tenant.workspaceId,
        tenant.userId,
        owner.callKey,
      ],
    },
    {
      sql: `INSERT INTO context_tool_audit(id,workspace_id,user_id,thread_id,run_id,message_id,call_key,tool_name,record_kind,record_id,result_id,outcome,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,'propose_memory','memory',?,?,'proposed',?,? WHERE EXISTS(SELECT 1 FROM memory_proposals WHERE id=?)`,
      params: [
        uuidv7(),
        tenant.workspaceId,
        tenant.userId,
        owner.threadId,
        owner.runId,
        owner.messageId,
        owner.callKey,
        target?.id ?? null,
        id,
        now,
        now,
        id,
      ],
    },
  ]);
  if (!results[0]?.rowsAffected) {
    const [won] = await db.select<{ result_id: string }>(
      "SELECT result_id FROM context_tool_audit WHERE workspace_id=? AND user_id=? AND call_key=? AND tool_name='propose_memory'",
      [tenant.workspaceId, tenant.userId, owner.callKey],
    );
    if (won) return { proposalId: won.result_id, status: "pending_review", repeated: true };
    throw new Error("Memory or conversation settings changed; read it again before proposing.");
  }
  return {
    proposalId: id,
    status: "pending_review",
    notice: "No active memory changed. The owner must review this in Settings → Memory.",
  };
}
