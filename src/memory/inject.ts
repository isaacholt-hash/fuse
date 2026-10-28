// Memory injection (PM-04): which saved facts go with a message. Keyword match within a token
// budget, plus meaning (embeddings) when an OpenAI key is there (M2 step 16).
import { textTokens } from "@/files/documents";
import type { Memory } from "@/storage/memories";

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

/** Rough tokens one memory adds to the prompt (its text plus the list marker). */
export const memoryTokens = (m: Pick<Memory, "text">) => textTokens(m.text) + 2;

/**
 * The memories to send with a message: global ones plus those of the chat's project. When they all
 * fit the budget they all go (a stable set also caches well, RT-07); otherwise the ones sharing the
 * most (and rarest) words with the message win, until the budget is used.
 */
export function selectMemories(
  memories: Memory[],
  query: string,
  projectId: string | null,
  budgetTokens: number,
  /** Cosine similarity of each memory to the question, by memory id (when embedded). */
  similarity: ReadonlyMap<string, number> = new Map(),
): Memory[] {
  const pool = memories.filter((m) => m.projectId === null || m.projectId === projectId);
  if (budgetTokens <= 0 || pool.length === 0) return [];
  const total = pool.reduce((sum, m) => sum + memoryTokens(m), 0);
  if (total <= budgetTokens) return pool;

  const words = pool.map((m) => keywords(m.text));
  const docFreq = new Map<string, number>();
  for (const set of words) for (const w of set) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
  const asked = keywords(query);
  const scored = pool
    .map((m, i) => {
      let score = 0;
      for (const w of words[i] ?? []) {
        if (asked.has(w)) score += Math.log(1 + pool.length / (docFreq.get(w) ?? 1));
      }
      // Meaning counts too: "my daughter" finds "Has a girl, Maya, aged 7".
      score += Math.max(0, (similarity.get(m.id) ?? 0) - SIMILARITY_FLOOR) * SIMILARITY_WEIGHT;
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt);

  const chosen = new Set<string>();
  let used = 0;
  for (const { m } of scored) {
    const cost = memoryTokens(m);
    if (used + cost > budgetTokens) continue;
    used += cost;
    chosen.add(m.id);
  }
  // Keep the saved order so the prompt reads the same way each time.
  return pool.filter((m) => chosen.has(m.id));
}
