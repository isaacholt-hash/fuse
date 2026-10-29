// The context assembler (PM-18): one module builds what every request carries, in this order:
// app guides, instructions (global, project, chat), decisions and constraints, open tasks,
// memories (ranked by kind, then relevance), the summary of earlier turns, artifacts you edited,
// then the history with any file excerpts and recalled chats on the question. Each part records
// where it came from. Send, edit, regenerate, retry, escalate and compare all come through here.
import type { EmbeddingModel } from "@/catalog/catalog";
import { ARTIFACT_GUIDE } from "@/artifacts/parse";
import type { ChatDeps } from "@/chat/sendMessage";
import { effectiveInstructions, systemPrompt } from "@/chat/instructions";
import { textTokens } from "@/files/documents";
import { memorySimilarity } from "@/knowledge/recall";
import {
  inScope,
  memoryLine,
  memoryTokens,
  pickMemories,
  type PickedMemory,
} from "@/memory/inject";
import type { ChatMessage } from "@/providers/types";
import { listArtifacts } from "@/storage/artifacts";
import { getGlobalInstructions } from "@/storage/instructions";
import { listMemories } from "@/storage/memories";
import { getProject } from "@/storage/projects";
import { getMemorySettings } from "@/storage/settings";
import { getThread } from "@/storage/threads";
import { allowedEmbedding, threadPolicy } from "./egress";
import type { Context } from "./gather";

export type PartKind =
  | "guide"
  | "instructions"
  | "decisions"
  | "tasks"
  | "memories"
  | "summary"
  | "artifacts"
  | "history";

/** One part of a request, with where it came from (ids, or the instruction level). */
export interface ContextPart {
  kind: PartKind;
  sources: string[];
  /** Rough tokens. */
  tokens: number;
}

export interface ContextPackage {
  system: string | undefined;
  history: ChatMessage[];
  /** In the order they're sent. */
  parts: ContextPart[];
  /** The memories sent and why (PM-17), recorded with the answer. */
  picked: PickedMemory[];
  /** File excerpts and recalled chats sent with the question, for the answer's citations. */
  fileSources: Context["fileSources"];
}

/** AR-02: artifacts you edited or restored, so the model works from what you have now. */
async function editedArtifacts(deps: Pick<ChatDeps, "db" | "tenant">, threadId: string) {
  const changed = (await listArtifacts(deps.db, deps.tenant, threadId)).filter(
    (a) => a.source !== "model",
  );
  if (changed.length === 0) return { text: null, sources: [] };
  return {
    text: [
      "<edited_artifacts>",
      "The user changed these artifacts after you last wrote them. This is their current content; build on it (same id) rather than on your earlier version.",
      ...changed.map(
        (a) =>
          `<artifact id="${a.key}" type="${a.type}" title="${a.title.replace(/"/g, "'")}"${a.language ? ` language="${a.language}"` : ""}>\n${a.content}\n</artifact>`,
      ),
      "</edited_artifacts>",
    ].join("\n"),
    sources: changed.map((a) => a.id),
  };
}

/**
 * Builds the request for an answer in `threadId` from the thread's gathered context. Read at send
 * time, so an edit to instructions, memories or decisions applies from the next message on.
 */
export async function assemble(
  deps: ChatDeps,
  threadId: string,
  { history, earlier, fileSources }: Context,
  wanted: EmbeddingModel | null | undefined,
): Promise<ContextPackage> {
  const { db, tenant } = deps;
  const embedding = allowedEmbedding(await threadPolicy(db, tenant, threadId), wanted);
  const thread = await getThread(db, tenant, threadId);
  const project = thread?.projectId ? await getProject(db, tenant, thread.projectId) : null;
  const instructions = effectiveInstructions(
    await getGlobalInstructions(db, tenant),
    project?.instructions ?? "",
    thread?.instructions ?? "",
  );

  // PM-04: memories in scope, ranked by shared words and, with an embedding model, meaning.
  // Decisions and constraints always go (PM-15). None at all when the chat turned memory off.
  const chooseMemories = async (): Promise<PickedMemory[]> => {
    const all = await listMemories(db, tenant);
    const budget = (await getMemorySettings(db, tenant)).budgetTokens;
    const question = history.findLast((m) => m.role === "user")?.content ?? "";
    const query = `${thread?.title ?? ""}\n${question}`;
    const where = { projectId: thread?.projectId ?? null, threadId };
    const pool = all.filter((m) => m.maySend && inScope(m, where));
    const overBudget = pool.reduce((sum, m) => sum + memoryTokens(m), 0) > budget;
    const similarity =
      overBudget && embedding && budget > 0
        ? await memorySimilarity(
            { ...deps, priceVersion: deps.catalog.priceVersion },
            embedding,
            pool,
            question,
            threadId,
          ).catch(() => new Map<string, number>()) // keywords alone still work
        : new Map<string, number>();
    return pickMemories(all, query, where, budget, similarity);
  };
  const picked = thread && !thread.memoryOn ? [] : await chooseMemories();
  const pinned = picked.filter(
    (p) => p.memory.kind === "decision" || p.memory.kind === "constraint",
  );
  const tasks = picked.filter((p) => p.memory.kind === "task");
  const memories = picked.filter((p) => !pinned.includes(p) && !tasks.includes(p));
  const artifacts = await editedArtifacts(deps, threadId);

  const lines = (list: PickedMemory[]) => list.map((p) => memoryLine(p.memory));
  const system = systemPrompt(instructions, {
    pinned: lines(pinned),
    tasks: lines(tasks),
    memories: lines(memories),
    earlier,
    guides: [ARTIFACT_GUIDE],
    tail: artifacts.text ? [artifacts.text] : [],
  });

  const ids = (list: PickedMemory[]) => list.map((p) => p.memory.id);
  const tokensOf = (list: PickedMemory[]) =>
    list.reduce((sum, p) => sum + memoryTokens(p.memory), 0);
  const parts: ContextPart[] = [
    { kind: "guide", sources: ["artifacts"], tokens: textTokens(ARTIFACT_GUIDE) },
    ...(instructions.length
      ? [
          {
            kind: "instructions" as const,
            sources: instructions.map((i) => i.source),
            tokens: instructions.reduce((sum, i) => sum + textTokens(i.text), 0),
          },
        ]
      : []),
    ...(pinned.length
      ? [{ kind: "decisions" as const, sources: ids(pinned), tokens: tokensOf(pinned) }]
      : []),
    ...(tasks.length
      ? [{ kind: "tasks" as const, sources: ids(tasks), tokens: tokensOf(tasks) }]
      : []),
    ...(memories.length
      ? [{ kind: "memories" as const, sources: ids(memories), tokens: tokensOf(memories) }]
      : []),
    ...(earlier
      ? [{ kind: "summary" as const, sources: [threadId], tokens: textTokens(earlier) }]
      : []),
    ...(artifacts.text
      ? [
          {
            kind: "artifacts" as const,
            sources: artifacts.sources,
            tokens: textTokens(artifacts.text),
          },
        ]
      : []),
    {
      kind: "history",
      sources: [threadId, ...fileSources.map((f) => f.chunkId)],
      tokens: history.reduce((sum, m) => sum + textTokens(m.content), 0),
    },
  ];
  return { system, history, parts, picked, fileSources };
}
