// Memory injection (PM-04): which saved facts go with a message. Keyword match within a token
// budget, plus meaning (embeddings) when an OpenAI key is there (M2 step 16).
import { textTokens } from "@/files/documents";
import type { Memory, UseReason } from "@/storage/memories";

const STOPWORDS = new Set(
  (
    "the and for are but not you your yours with this that these those from have has had was were " +
    "will would can could should what when where which who whom why how all any each few more most " +
    "other some such only own same than too very just about into over after before then once here " +
    "there out off again also our ours they them their his her she him its it's i'm i've i'd don't " +
    "does did doing done been being get got make made like want need know think tell give use using " +
    "please thanks thank hey okay yes"
  ).split(" "),
);

/** Lowercase content words, with a crude plural strip so "dogs" matches "dog". */
export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** Below this cosine similarity a memory isn't related; above it, it scores like a shared word. */
const SIMILARITY_FLOOR = 0.3;
const SIMILARITY_WEIGHT = 6;

type Line = Pick<Memory, "text"> &
  Partial<Pick<Memory, "kind" | "rationale" | "alternatives" | "taskStatus">>;

/** How a memory reads in the prompt: decisions with their reason and what was ruled out. */
export function memoryLine(m: Line): string {
  if (m.kind === "decision") {
    const alts = m.alternatives ?? [];
    return [
      `Decision: ${m.text}`,
      m.rationale ? `Reason: ${m.rationale}` : null,
      alts.length ? `Ruled out: ${alts.join("; ")}` : null,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (m.kind === "constraint") return `Constraint: ${m.text}`;
  if (m.kind === "task")
    return `Task (${m.taskStatus === "doing" ? "in progress" : "to do"}): ${m.text}`;
  return m.text;
}

/** Rough tokens one memory adds to the prompt (its line plus the list marker). */
export const memoryTokens = (m: Line) => textTokens(memoryLine(m)) + 2;

/**
 * Decisions and constraints (PM-15) and open tasks (PM-16) always go, ahead of other memories,
 * never cut for budget: they're what a project needs to carry on with any model (PM-19).
 */
export const isPinned = (m: Pick<Memory, "kind">) =>
  m.kind === "decision" || m.kind === "constraint" || m.kind === "task";

/** Where a message is being sent from: its project and chat. */
export interface MemoryWhere {
  projectId: string | null;
  threadId: string | null;
}

/** PM-13: global records apply everywhere, project ones in that project, conversation ones in that chat. */
export const inScope = (
  m: Pick<Memory, "scope" | "projectId" | "threadId">,
  where: MemoryWhere,
): boolean =>
  m.scope === "conversation"
    ? m.threadId !== null && m.threadId === where.threadId
    : m.projectId === null || m.projectId === where.projectId;

/** Why a memory went with a message (PM-17). */
export type PickReason = UseReason;

export interface PickedMemory {
  memory: Memory;
  reason: PickReason;
  /** Keyword plus meaning score when it was ranked; null when it went without ranking. */
  score: number | null;
}

/**
 * The memories to send with a message: global ones plus those of the chat's project and the
 * chat itself. Decisions and constraints always go first. When the rest all fit the budget they
 * all go (a stable set also caches well, RT-07); otherwise the ones sharing the most (and
 * rarest) words or meaning with the message win, until the budget is used.
 */
export function selectMemories(
  memories: Memory[],
  query: string,
  where: MemoryWhere,
  budgetTokens: number,
  /** Cosine similarity of each memory to the question, by memory id (when embedded). */
  similarity: ReadonlyMap<string, number> = new Map(),
): Memory[] {
  return pickMemories(memories, query, where, budgetTokens, similarity).map((p) => p.memory);
}

/** `selectMemories`, with why each one was chosen (PM-17). */
export function pickMemories(
  memories: Memory[],
  query: string,
  where: MemoryWhere,
  budgetTokens: number,
  similarity: ReadonlyMap<string, number> = new Map(),
): PickedMemory[] {
  // Records kept on this device never go to a provider (SE-13).
  // Finished and dropped tasks are history, not context (PM-16).
  const pool = memories.filter(
    (m) =>
      m.maySend &&
      inScope(m, where) &&
      !(m.kind === "task" && (m.taskStatus === "done" || m.taskStatus === "dropped")),
  );
  if (budgetTokens <= 0 || pool.length === 0) return [];
  const pinned = pool
    .filter(isPinned)
    .map((memory): PickedMemory => ({ memory, reason: "always", score: null }));
  const others = pool.filter((m) => !isPinned(m));
  const room = budgetTokens - pinned.reduce((sum, p) => sum + memoryTokens(p.memory), 0);
  const total = others.reduce((sum, m) => sum + memoryTokens(m), 0);
  if (total <= room) {
    return [
      ...pinned,
      ...others.map((memory): PickedMemory => ({ memory, reason: "all_fit", score: null })),
    ];
  }
  return [...pinned, ...rankWithin(others, query, room, similarity)];
}

/** The memories sharing the most (and rarest) words or meaning with the question, within `budgetTokens`. */
function rankWithin(
  pool: Memory[],
  query: string,
  budgetTokens: number,
  similarity: ReadonlyMap<string, number>,
): PickedMemory[] {
  if (budgetTokens <= 0) return [];

  const words = pool.map((m) => keywords(m.text));
  const docFreq = new Map<string, number>();
  for (const set of words) for (const w of set) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
  const asked = keywords(query);
  const scored = pool
    .map((m, i) => {
      let byWords = 0;
      for (const w of words[i] ?? []) {
        if (asked.has(w)) byWords += Math.log(1 + pool.length / (docFreq.get(w) ?? 1));
      }
      // Meaning counts too: "my daughter" finds "Has a girl, Maya, aged 7".
      const byMeaning =
        Math.max(0, (similarity.get(m.id) ?? 0) - SIMILARITY_FLOOR) * SIMILARITY_WEIGHT;
      const reason: PickReason = byMeaning > byWords ? "meaning" : "keyword";
      return { m, score: byWords + byMeaning, reason };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt);

  const chosen = new Map<string, PickedMemory>();
  let used = 0;
  for (const { m, score, reason } of scored) {
    const cost = memoryTokens(m);
    if (used + cost > budgetTokens) continue;
    used += cost;
    chosen.set(m.id, { memory: m, reason, score: Math.round(score * 100) / 100 });
  }
  // Keep the saved order so the prompt reads the same way each time.
  return pool.flatMap((m) => chosen.get(m.id) ?? []);
}

const REASONS: Record<PickReason, string> = {
  always: "always sent: a decision, constraint or open task",
  all_fit: "all your memories fit the budget",
  keyword: "shares words with your message",
  meaning: "close in meaning to your message",
};

/** "shares words with your message (score 2.4)" */
export const explainPick = (reason: PickReason | null, score: number | null): string =>
  reason ? `${REASONS[reason]}${score !== null ? ` (score ${score.toFixed(1)})` : ""}` : "";
