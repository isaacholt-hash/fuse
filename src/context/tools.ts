import type { ToolCall } from "@/providers/types";
import type { EmbeddingModel } from "@/catalog/catalog";
import { uuidv7 } from "@/storage/ids";
import { checkInput } from "@/agent/checkInput";
import type { ContextOwner } from "./access";
import { CONTEXT_READ_TOOLS, CONTEXT_WRITE_TOOLS, contextInput } from "./toolSpecs";
import { readMemory, proposeMemory } from "./memoryTools";
import { readArtifact, writeArtifact } from "./artifactTools";
import { findArtifacts, type ArtifactSearchDeps } from "./artifactSearch";
export async function contextTool(
  deps: ArtifactSearchDeps,
  owner: ContextOwner,
  call: ToolCall,
  embedding?: EmbeddingModel | null,
  signal?: AbortSignal,
): Promise<{ output: string; isError: boolean }> {
  try {
    call = { ...call, input: contextInput(call.name, call.input) };
    if (signal?.aborted) throw new Error("Context tool cancelled.");
    const tool = [...CONTEXT_READ_TOOLS, ...CONTEXT_WRITE_TOOLS].find((t) => t.name === call.name);
    if (!tool) throw new Error("Unknown context tool.");
    const invalid = checkInput(tool.schema, call.input);
    if (invalid) throw new Error(invalid);
    const value =
      call.name === "read_memory"
        ? await readMemory(deps, owner, call.input)
        : call.name === "propose_memory"
          ? await proposeMemory(deps, owner, call.input, signal)
          : call.name === "read_artifact"
            ? await readArtifact(deps, owner, call.input)
            : call.name === "search_artifacts"
              ? await findArtifacts(deps, owner, String(call.input.query), {
                  meaning: call.input.meaning === true,
                  embedding,
                  signal,
                })
              : await writeArtifact(
                  deps,
                  owner,
                  call.name as "create_artifact" | "update_artifact",
                  call.input,
                  signal,
                );
    const now = Date.now();
    await deps.db.execute(
      `INSERT OR IGNORE INTO context_tool_audit(id,workspace_id,user_id,thread_id,run_id,message_id,call_key,tool_name,record_kind,record_id,outcome,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,'read',?,? WHERE EXISTS(SELECT 1 FROM threads WHERE id=? AND workspace_id=? AND user_id=? AND deleted_at IS NULL)`,
      [
        uuidv7(),
        deps.tenant.workspaceId,
        deps.tenant.userId,
        owner.threadId,
        owner.runId,
        owner.messageId,
        owner.callKey,
        call.name,
        call.name.includes("memory") ? "memory" : "artifact",
        null,
        now,
        now,
        owner.threadId,
        deps.tenant.workspaceId,
        deps.tenant.userId,
      ],
    );
    return { output: JSON.stringify(value), isError: false };
  } catch (e) {
    if ([...CONTEXT_READ_TOOLS, ...CONTEXT_WRITE_TOOLS].some((t) => t.name === call.name)) {
      const now = Date.now();
      await deps.db
        .execute(
          `INSERT OR IGNORE INTO context_tool_audit(id,workspace_id,user_id,thread_id,run_id,message_id,call_key,tool_name,record_kind,outcome,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,'refused',?,? WHERE EXISTS(SELECT 1 FROM threads WHERE workspace_id=? AND user_id=? AND id=? AND deleted_at IS NULL)`,
          [
            uuidv7(),
            deps.tenant.workspaceId,
            deps.tenant.userId,
            owner.threadId,
            owner.runId,
            owner.messageId,
            owner.callKey,
            call.name,
            call.name.includes("memory") ? "memory" : "artifact",
            now,
            now,
            deps.tenant.workspaceId,
            deps.tenant.userId,
            owner.threadId,
          ],
        )
        .catch(() => undefined);
    }
    return { output: e instanceof Error ? e.message : "Context tool failed.", isError: true };
  }
}
