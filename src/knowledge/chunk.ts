/**
 * Splits text into chunks for embedding (FK-02): about CHUNK_TOKENS each, on paragraph and line
 * boundaries where possible, with a little overlap so a fact cut in two is still found.
 * Each chunk keeps its line range for citations.
 */
import { PAGE_MARKER } from "@/files/pdfText";
import type { NewChunk } from "@/storage/vectors";

export const CHUNK_TOKENS = 400;
const OVERLAP_LINES = 2;
const tokensOf = (text: string) => Math.ceil(text.length / 4);

export function chunkText(text: string, maxTokens = CHUNK_TOKENS): NewChunk[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // A PDF's text carries page markers (pdfText.ts): each line's page, for citations.
  const pageOf: (number | null)[] = [];
  let page: number | null = null;
  for (const line of lines) {
    const m = PAGE_MARKER.exec(line);
    if (m) page = Number(m[1]);
    pageOf.push(page);
  }
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
        // The page the chunk's text starts on (a marker line itself belongs to its page).
        const first = lines.slice(start, end).findIndex((l) => l.trim() && !PAGE_MARKER.test(l));
        const chunkPage = pageOf[start + Math.max(0, first)] ?? null;
        out.push({
          ordinal: out.length,
          text: p.trim(),
          tokens: tokensOf(p),
          ...(chunkPage === null
            ? { lineStart: start + 1, lineEnd: end }
            : { page: chunkPage, lineStart: null, lineEnd: null }),
        });
      }
    }
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - OVERLAP_LINES);
  }
  return out;
}
