/**
 * Recall (PM-04, PM-10): memories found by meaning, and "what did we decide about X" answered from
 * past chats, with the chats cited.
 */
import type { EmbeddingModel } from "@/catalog/catalog";
import { keywords } from "@/memory/inject";
import type { Memory } from "@/storage/memories";
import { searchChats } from "@/storage/search";
import { listChunks, nearest, replaceChunks } from "@/storage/vectors";
import { embedTexts, indexChunks, modelKey, type EmbedDeps } from "./embed";

/**
 * Similarity of each memory to the question (memory id → cosine). Memories are embedded the first
 * time they're needed, and again after an edit.
 */
export async function memorySimilarity(
  deps: EmbedDeps,
  model: EmbeddingModel,
  memories: readonly Memory[],
  question: string,
  threadId: string | null,
): Promise<Map<string, number>> {
  if (memories.length === 0 || !question.trim()) return new Map();
  for (const m of memories) {
    const [chunk] = await listChunks(deps.db, deps.tenant, "memory", m.id);
    if (chunk?.text !== m.text) {
      await replaceChunks(deps.db, deps.tenant, "memory", m.id, [
        { ordinal: 0, text: m.text, tokens: Math.ceil(m.text.length / 4) },
      ]);
    }
  }
  const ids = memories.map((m) => m.id);
  await indexChunks(deps, model, "memory", ids);
  const [query] = await embedTexts(deps, model, [question], threadId);
  if (!query) return new Map();
  const hits = await nearest(
    deps.db,
    deps.tenant,
    modelKey(model),
    query,
    { kind: "memory", ids },
    ids.length,
  );
  return new Map(hits.map((h) => [h.chunk.sourceId, h.score]));
}

/** "What did we decide…", "remind me what we said…", "last week we talked about…" (PM-10). */
const RECALL =
  /\b(what (did|have) (we|i|you) (decide|decided|say|said|discuss|discussed|agree|agreed|conclude|concluded|talk about|plan|planned)|remind me (what|of|about)|(last|previous|earlier|other) (chat|conversation|time|week|month)|we (talked|spoke|chatted) about|did (we|i) (ever )?(talk|discuss|mention))\b/i;

export function isRecallQuestion(text: string): boolean {
  return RECALL.test(text);
}

/** Words that ask for recall rather than name the topic. */
const RECALL_WORDS = new Set(
  "decide decided said say discuss discussed agree agreed conclude concluded talk talked spoke chatted plan planned remind remember last previous earlier other week month time chat conversation ever mention mentioned".split(
    " ",
  ),
);

export interface Recalled {
  text: string;
  sources: { chunkId: string; label: string }[];
}

const MAX_HITS = 6;
const MAX_CHARS = 1_500;

/** The parts of other chats that match the question's topic, newest first, with their chats. */
export async function recallPastChats(
  deps: Pick<EmbedDeps, "db" | "tenant">,
  question: string,
  currentThreadId: string,
): Promise<Recalled | null> {
  const topic = [...keywords(question)].filter((w) => !RECALL_WORDS.has(w));
  if (topic.length === 0) return null;
  // Any of the topic words, best match first (FTS5 OR), skipping this chat.
  let hits = await searchChats(deps.db, deps.tenant, topic.join(" "), 30);
  if (hits.filter((h) => h.messageId).length === 0 && topic.length > 1) {
    const found = await Promise.all(topic.map((w) => searchChats(deps.db, deps.tenant, w, 10)));
    hits = found.flat();
  }
  const perThread = new Map<string, number>();
  const picked = hits.filter((h) => {
    if (!h.messageId || h.threadId === currentThreadId) return false;
    const n = perThread.get(h.threadId) ?? 0;
    if (n >= 2) return false;
    perThread.set(h.threadId, n + 1);
    return true;
  });
  const chosen = picked.slice(0, MAX_HITS);
  if (chosen.length === 0) return null;
  const rows = await deps.db.select<{ id: string; content: string; created_at: number }>(
    `SELECT id, content, created_at FROM messages WHERE workspace_id = ? AND id IN (${chosen.map(() => "?").join(", ")})`,
    [deps.tenant.workspaceId, ...chosen.map((h) => h.messageId ?? "")],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const date = (ms: number) =>
    new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const parts = chosen.flatMap((h) => {
    const row = h.messageId ? byId.get(h.messageId) : undefined;
    if (!row) return [];
    const text =
      row.content.length > MAX_CHARS ? `${row.content.slice(0, MAX_CHARS)} […]` : row.content;
    return [
      {
        h,
        when: date(row.created_at),
        block: `<past_chat title="${h.threadTitle.replace(/"/g, "'")}" date="${date(row.created_at)}" from="${h.role === "user" ? "user" : "assistant"}">\n${text}\n</past_chat>`,
      },
    ];
  });
  if (parts.length === 0) return null;
  return {
    text: [
      "The user is asking about an earlier conversation. These are the parts of their past chats that best match the topic, with each chat's title and date. Answer from them, say which chat (title and date) it came from, and say plainly if they don't settle it.",
      ...parts.map((p) => p.block),
    ].join("\n\n"),
    sources: [
      ...new Map(
        parts.map((p) => [
          p.h.threadId,
          { chunkId: `thread:${p.h.threadId}`, label: `Chat: ${p.h.threadTitle} (${p.when})` },
        ]),
      ).values(),
    ],
  };
}
