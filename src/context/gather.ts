// The context assembler's first half (PM-18): what a thread contributes to a request. The
// history (with attachments), the summary of older turns, excerpts from searched files and
// recalled past chats. `assemble.ts` adds instructions, decisions, tasks and memories.
import type { EmbeddingModel } from "@/catalog/catalog";
import type { ChatDeps } from "@/chat/sendMessage";
import { summarizedPath } from "@/chat/summary";
import { toBase64 } from "@/files/api";
import { retrieveExcerpts } from "@/knowledge/retrieve";
import { isRecallQuestion, recallPastChats } from "@/knowledge/recall";
import type { Attachment, ChatMessage } from "@/providers/types";
import { filesForMessages } from "@/storage/files";
import type { Message } from "@/storage/messages";
import { listProjectFiles } from "@/storage/projectFiles";
import { getThread } from "@/storage/threads";
import { allowedEmbedding, threadPolicy } from "./egress";

/**
 * The history sent to the model: every saved turn with text, oldest first. The same plain-text
 * history goes to any provider, which is what makes switching model mid-thread work (CH-03).
 * Failed answers with no text are left out; partial answers (stopped, cut off) are kept.
 * An answer re-run on a stronger model (RT-04) is left out in favour of the newer one.
 */
export function historyFor(
  messages: Message[],
  attachments: ReadonlyMap<string, Attachment[]> = new Map(),
  runs: ReadonlyMap<string, "code" | "work"> = new Map(),
): ChatMessage[] {
  const superseded = new Set(messages.map((m) => m.escalatedFromId).filter(Boolean));
  return messages
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        !superseded.has(m.id) &&
        (m.content.trim() !== "" || attachments.has(m.id)),
    )
    .map((m) => {
      const files = attachments.get(m.id);
      const run = runs.get(m.id);
      return {
        role: m.role as "user" | "assistant",
        // A model without tools, answering later, would otherwise doubt what a run did.
        content: run ? `${m.content}\n\n${runNote(run)}` : m.content,
        ...(files ? { attachments: files } : {}),
      };
    });
}

/** Added to an answer a run gave, in the history only (the saved answer is unchanged). */
export const runNote = (kind: "code" | "work") =>
  `[FUSE: this answer came from a ${kind === "work" ? "Work" : "Code"} run that used tools in the chat's folders. The changes it describes were made and are shown in the app.]`;

/** Which answers in a thread came from a Code or Work run. */
async function runKinds(deps: ChatDeps, threadId: string): Promise<Map<string, "code" | "work">> {
  const rows = await deps.db.select<{ message_id: string; kind: string }>(
    `SELECT message_id, kind FROM runs
     WHERE workspace_id = ? AND thread_id = ? AND message_id IS NOT NULL`,
    [deps.tenant.workspaceId, threadId],
  );
  return new Map(rows.map((r) => [r.message_id, r.kind === "work" ? "work" : "code"]));
}

/** Loads the bytes of every file attached to these messages (resent each turn). */
async function attachmentsFor(
  deps: ChatDeps,
  messages: Message[],
): Promise<Map<string, Attachment[]>> {
  const byMessage = await filesForMessages(
    deps.db,
    deps.tenant,
    messages.filter((m) => m.role === "user").map((m) => m.id),
  );
  const out = new Map<string, Attachment[]>();
  for (const [messageId, files] of byMessage) {
    if (!deps.files) throw new Error("This message has attachments but no file store is set up");
    const loaded: Attachment[] = [];
    for (const f of files) {
      if (f.mode === "retrieval") {
        // Searched per question (FK-03): only a note goes in the history; excerpts come with
        // the question being answered (contextOf).
        loaded.push({
          kind: "text",
          name: f.name,
          text: "(A large file. It isn't sent whole: the parts that match each question are.)",
        });
        continue;
      }
      const bytes = await deps.files.get(f.sha256);
      if (f.mime.startsWith("image/")) {
        loaded.push({ kind: "image", mediaType: f.mime, data: toBase64(bytes) });
      } else if (f.mime === "application/pdf") {
        loaded.push({ kind: "pdf", name: f.name, data: toBase64(bytes) });
      } else {
        loaded.push({ kind: "text", name: f.name, text: new TextDecoder().decode(bytes) });
      }
    }
    out.set(messageId, loaded);
  }
  return out;
}

/** What a model is sent before the new answer: the history and any summary of older turns. */
export interface Context {
  history: ChatMessage[];
  earlier: string | null;
  /** File excerpts sent with the question, for the answer's citations (FK-02). */
  fileSources: { chunkId: string; label: string }[];
}

/**
 * Older turns go as a summary once the thread has one (PM-06); the rest is sent in full. Large
 * files are searched: the question gets the excerpts that match it (FK-02).
 */
export async function gatherContext(
  deps: ChatDeps,
  threadId: string,
  path: Message[],
  wanted: EmbeddingModel | null | undefined,
): Promise<Context> {
  // SE-13: no embedding when the project forbids it; keyword-only memory search still works.
  const policy = await threadPolicy(deps.db, deps.tenant, threadId);
  const embedding = allowedEmbedding(policy, wanted);
  const { earlier, kept } = await summarizedPath(deps, threadId, path);
  const history = historyFor(
    kept,
    await attachmentsFor(deps, kept),
    await runKinds(deps, threadId),
  );
  const files = await filesForMessages(
    deps.db,
    deps.tenant,
    kept.filter((m) => m.role === "user").map((m) => m.id),
  );
  // PM-09: a project's knowledge files are searched for every chat in it.
  const thread = await getThread(deps.db, deps.tenant, threadId);
  // Knowledge files kept on this device are never searched for a request (SE-13).
  const knowledge = thread?.projectId
    ? (await listProjectFiles(deps.db, deps.tenant, thread.projectId)).filter((f) => f.maySend)
    : [];
  const searched = [
    ...new Map(
      [...[...files.values()].flat().filter((f) => f.mode === "retrieval"), ...knowledge].map(
        (f) => [f.id, f],
      ),
    ).values(),
  ];
  const last = history.at(-1);
  const question = kept.findLast((m) => m.role === "user")?.content ?? "";
  // PM-10: "what did we decide about X" gets the matching parts of past chats.
  const recalled =
    last?.role === "user" && isRecallQuestion(question)
      ? await recallPastChats(deps, question, threadId)
      : null;
  if (recalled && last) {
    last.attachments = [
      ...(last.attachments ?? []),
      { kind: "text", name: "From your earlier chats", text: recalled.text },
    ];
  }
  const recallSources = recalled?.sources ?? [];
  if (searched.length === 0 || last?.role !== "user") {
    return { history, earlier, fileSources: recallSources };
  }
  // LL-05: files are searched by their words on this computer, so this works with no OpenAI key
  // and in projects that don't allow embedding; meaning is merged in when it's allowed.
  if (!deps.files) throw new Error("This message has attachments but no file store is set up");
  const excerpts = await retrieveExcerpts(
    { ...deps, files: deps.files, priceVersion: deps.catalog.priceVersion },
    embedding,
    searched,
    question,
    threadId,
  );
  last.attachments = [
    ...(last.attachments ?? []),
    { kind: "text", name: "Excerpts from your files", text: excerpts.text },
  ];
  return { history, earlier, fileSources: [...excerpts.sources, ...recallSources] };
}
