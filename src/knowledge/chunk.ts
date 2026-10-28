/**
 * Splits text into chunks for embedding (FK-02): about CHUNK_TOKENS each, on paragraph and line
 * boundaries where possible, with a little overlap so a fact cut in two is still found.
 * Each chunk keeps its line range for citations.
 */
import type { NewChunk } from "@/storage/vectors";

export const CHUNK_TOKENS = 400;
const OVERLAP_LINES = 2;
const tokensOf = (text: string) => Math.ceil(text.length / 4);

export function chunkText(text: string, maxTokens = CHUNK_TOKENS): NewChunk[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: NewChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let tokens = 0;
    // Take whole lines up to the budget; a single huge line is cut by characters.
    while (end < lines.length) {
      const t = tokensOf(lines[end] ?? "") + 1;
      if (tokens > 0 && tokens + t > maxTokens) break;
      tokens += t;
      end += 1;
      if (tokens >= maxTokens) break;
    }
    const piece = lines.slice(start, end).join("\n");
    const pieces =
      tokensOf(piece) > maxTokens * 1.5
        ? (piece.match(new RegExp(`[\\s\\S]{1,${String(maxTokens * 4)}}`, "g")) ?? [])
        : [piece];
    for (const p of pieces) {
      if (p.trim()) {
        out.push({
          ordinal: out.length,
          text: p.trim(),
          tokens: tokensOf(p),
          lineStart: start + 1,
          lineEnd: end,
        });
      }
    }
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - OVERLAP_LINES);
  }
  return out;
}
