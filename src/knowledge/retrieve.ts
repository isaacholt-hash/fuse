/**
 * Retrieval over large files (FK-02, FK-03): a file too big to resend every turn is chunked once,
 * and each question gets the excerpts that match it best, with citations. Matching is by words
 * first, on this computer (LL-05, FTS5), so it works with no OpenAI key; with an embedding model
 * the two rankings are merged.
 */
import { threadScope, type SendScope } from "@/providers/types";
import type { EmbeddingModel } from "@/catalog/catalog";
import type { FilesApi } from "@/files/api";
import type { FileRecord } from "@/storage/files";
import { lexicalNearest, listChunks, nearest, replaceChunks, type Match } from "@/storage/vectors";
import { chunkText } from "./chunk";
import { embedTexts, indexChunks, modelKey, type EmbedDeps } from "./embed";

/** Excerpts per question: about 3,000 tokens at 400 tokens a chunk. */
export const EXCERPTS = 8;

export interface Excerpts {
  /** Sent to the model with the question. */
  text: string;
  /** For the answer's "From your files" list. */
  sources: { chunkId: string; label: string }[];
}

/**
 * Chunks a file once (the chunks are indexed by word as they're saved), and with a model embeds
 * them too (later calls only embed chunks that lack a vector).
 */
export async function ensureIndexed(
  deps: EmbedDeps & { files: FilesApi },
  model: EmbeddingModel | null,
  file: FileRecord,
  /** Where the file's text may be sent (SE-13): its chat's or its project's scope. */
  scope: SendScope = { kind: "global" },
): Promise<void> {
  if ((await listChunks(deps.db, deps.tenant, "file", file.id)).length === 0) {
    const text = new TextDecoder().decode(await deps.files.get(file.sha256));
    await replaceChunks(deps.db, deps.tenant, "file", file.id, chunkText(text));
  }
  if (model) await indexChunks(deps, model, "file", [file.id], undefined, scope);
}

/** Reciprocal rank fusion: a chunk high in either ranking rises; k = 60 as usual. */
export function fuse(rankings: readonly Match[][], limit: number): Match[] {
  const scores = new Map<string, { match: Match; score: number }>();
  for (const ranking of rankings) {
    ranking.forEach((m, rank) => {
      const entry = scores.get(m.chunk.id) ?? { match: m, score: 0 };
      entry.score += 1 / (60 + rank + 1);
      scores.set(m.chunk.id, entry);
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => e.match);
}

const lines = (a: number | null, b: number | null) =>
  a === null ? "" : b === null || b === a ? `line ${String(a)}` : `lines ${String(a)}–${String(b)}`;
/** Where a chunk is: its page (PDFs) or its lines. */
const where = (c: { page: number | null; lineStart: number | null; lineEnd: number | null }) =>
  c.page !== null ? `page ${String(c.page)}` : lines(c.lineStart, c.lineEnd);

/** The parts of these files that best match the question, in file order. */
export async function retrieveExcerpts(
  deps: EmbedDeps & { files: FilesApi },
  model: EmbeddingModel | null,
  files: readonly FileRecord[],
  question: string,
  threadId: string | null,
): Promise<Excerpts> {
  const ids = files.map((f) => f.id);
  const asked = question || files.map((f) => f.name).join(", ");
  let embedded = model;
  for (const f of files) {
    try {
      await ensureIndexed(deps, embedded, f, threadScope(threadId));
    } catch {
      // An embedding failure falls back to words alone (LL-05); the chunks are saved by now.
      embedded = null;
      await ensureIndexed(deps, null, f, threadScope(threadId));
    }
  }
  const byWords = await lexicalNearest(
    deps.db,
    deps.tenant,
    asked,
    { kind: "file", ids },
    2 * EXCERPTS,
  );
  let byMeaning: Match[] = [];
  if (embedded) {
    try {
      const [query] = await embedTexts(deps, embedded, [asked], threadId);
      if (query) {
        byMeaning = await nearest(
          deps.db,
          deps.tenant,
          modelKey(embedded),
          query,
          { kind: "file", ids },
          2 * EXCERPTS,
        );
      }
    } catch {
      byMeaning = [];
    }
  }
  let hits = fuse([byMeaning, byWords], EXCERPTS);
  if (hits.length === 0) {
    // No word in common and no embeddings: the start of each file, so the model has something.
    const all = (
      await Promise.all(ids.map((id) => listChunks(deps.db, deps.tenant, "file", id)))
    ).flat();
    hits = all.slice(0, EXCERPTS).map((chunk) => ({ chunk, score: 0 }));
  }
  const name = new Map(files.map((f) => [f.id, f.name]));
  const ordered = [...hits].sort(
    (a, b) => a.chunk.sourceId.localeCompare(b.chunk.sourceId) || a.chunk.ordinal - b.chunk.ordinal,
  );
  const label = (h: (typeof hits)[number]) =>
    [name.get(h.chunk.sourceId) ?? "A file", where(h.chunk)].filter(Boolean).join(", ");
  return {
    text: [
      "Excerpts from the user's attached files that best match the question (the files are too long to send whole). Answer from them where they help, and say which file and page or lines you used. If they don't cover the question, say so.",
      ...ordered.map(
        (h) =>
          `<excerpt file="${name.get(h.chunk.sourceId) ?? ""}" ${where(h.chunk)}>\n${h.chunk.text}\n</excerpt>`,
      ),
    ].join("\n\n"),
    sources: ordered.map((h) => ({ chunkId: h.chunk.id, label: label(h) })),
  };
}
