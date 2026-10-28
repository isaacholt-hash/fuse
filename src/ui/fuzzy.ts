// Fuzzy matching for the command palette (CH-08).

/**
 * Subsequence match: every typed character in order, earlier and tighter matches scoring
 * higher, word starts best. Null when it doesn't match.
 */
export function fuzzyScore(query: string, label: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const l = label.toLowerCase();
  let score = 0;
  let from = 0;
  let last = -1;
  for (const ch of q) {
    const at = l.indexOf(ch, from);
    if (at < 0) return null;
    score += at === last + 1 ? 3 : 1; // runs
    if (at === 0 || l[at - 1] === " " || l[at - 1] === ":") score += 4; // word starts
    score -= Math.min(at - from, 5) * 0.2; // gaps
    last = at;
    from = at + 1;
  }
  return score;
}
