/** Use the shared assembler with an explicit selection; never acquire a folder or MCP grant. */
import type { ChatDeps } from "@/chat/sendMessage";
import { assemble } from "@/context/assemble";
import { egressRefusal, threadPolicy } from "@/context/egress";
import { inScope } from "@/memory/inject";
import { listMemories } from "@/storage/memories";
import { listMessages } from "@/storage/messages";
import { listArtifacts } from "@/storage/artifacts";
import { getThread } from "@/storage/threads";
import type { ProviderId } from "@/catalog/catalog";
import type { ResearchSelection } from "./types";
import config from "../../data/research.json";

export function validateSelection(selection: ResearchSelection): void {
  for (const ids of [selection.memoryIds, selection.artifactIds, selection.messageIds])
    if (
      !Array.isArray(ids) ||
      ids.length > config.execution.max_context_items ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== "string" || !id || id.length > 128)
    )
      throw new Error("Select a bounded set of existing context records.");
  if (
    !Array.isArray(selection.instructions) ||
    selection.instructions.some((level) => !["global", "project", "thread"].includes(level))
  )
    throw new Error("Invalid instruction selection.");
}
export async function selectedContext(
  deps: Pick<ChatDeps, "db" | "tenant" | "catalog" | "adapterFor">,
  threadId: string,
  task: string,
  selection: ResearchSelection,
  provider: ProviderId,
  location: "desktop" | "hulk",
) {
  validateSelection(selection);
  const thread = await getThread(deps.db, deps.tenant, threadId);
  if (!thread || thread.kind !== "chat") throw new Error("Research starts in Chat.");
  if (thread.incognito)
    throw new Error(
      "Research keeps durable progress and reports. Use a normal Chat; incognito content is excluded.",
    );
  const flags = (
    await deps.db.select<{ local_only: number; deleted_at: number | null }>(
      "SELECT local_only,deleted_at FROM threads WHERE workspace_id=? AND id=?",
      [deps.tenant.workspaceId, threadId],
    )
  )[0];
  if (!flags || flags.deleted_at !== null)
    throw new Error("The selected Chat is no longer available.");
  if (location === "hulk" && flags.local_only === 1)
    throw new Error("Keep-on-this-device content cannot be transferred to HULK.");
  if (provider === "local") throw new Error("Local models are restricted to housekeeping.");
  const refusal = egressRefusal(
    await threadPolicy(deps.db, deps.tenant, threadId),
    provider,
    "chat",
  );
  if (refusal) throw new Error(refusal);
  const memories = await listMemories(deps.db, deps.tenant);
  if (selection.memoryIds.length > 0 && !thread.memoryOn)
    throw new Error("This Chat has memory disabled. Review the context selection.");
  for (const id of selection.memoryIds) {
    const memory = memories.find((m) => m.id === id);
    if (!memory || !memory.maySend || !inScope(memory, { projectId: thread.projectId, threadId }))
      throw new Error(
        "A selected memory is unavailable, private, conflicted or outside this Chat's scope.",
      );
  }
  const artifacts = await listArtifacts(deps.db, deps.tenant, threadId);
  if (selection.artifactIds.some((id) => !artifacts.some((a) => a.id === id)))
    throw new Error("A selected artifact is unavailable or outside this Chat.");
  const messages = await listMessages(deps.db, deps.tenant, threadId);
  const chosen = selection.messageIds.map((id) => {
    const message = messages.find((m) => m.id === id);
    if (!message || message.status === "streaming")
      throw new Error("A selected message changed or is no longer available.");
    return {
      role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: message.content,
    };
  });
  // Construct only these dependencies: even a caller carrying Code dependencies cannot add repo/MCP context.
  const context = await assemble(
    { db: deps.db, tenant: deps.tenant, catalog: deps.catalog, adapterFor: deps.adapterFor },
    threadId,
    { history: [...chosen, { role: "user", content: task }], earlier: null, fileSources: [] },
    null,
    undefined,
    selection,
  );
  const serialized = JSON.stringify({
    system: context.system,
    history: context.history,
    parts: context.parts,
  });
  if (new TextEncoder().encode(serialized).length > config.execution.max_selected_context_chars)
    throw new Error(
      "The selected context is too large. Select fewer records before starting research.",
    );
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized)),
  );
  const fingerprint = Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join("");
  return { ...context, fingerprint };
}
