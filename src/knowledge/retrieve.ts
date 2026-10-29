/**
 * Retrieval over large files (FK-02, FK-03): a file too big to resend every turn is chunked and
 * embedded once, and each question gets the excerpts that match it best, with citations.
 */
import type { EmbeddingModel } from "@/catalog/catalog";
import type { FilesApi } from "@/files/api";
import type { FileRecord } from "@/storage/files";
import { listChunks, nearest, replaceChunks } from "@/storage/vectors";
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

/** Chunks and embeds a file once (later calls only embed chunks that lack a vector). */
export async function ensureIndexed(
  deps: EmbedDeps & { files: FilesApi },
  model: EmbeddingModel,
  file: FileRecord,
): Promise<void> {
  if ((await listChunks(deps.db, deps.tenant, "file", file.id)).length === 0) {
    const text = new TextDecoder().decode(await deps.files.get(file.sha256));
    await replaceChunks(deps.db, deps.tenant, "file", file.id, chunkText(text));
  }
  await indexChunks(deps, model, "file", [file.id]);
}

const lines = (a: number | null, b: number | null) =>
  a === null ? "" : b === null || b === a ? `line ${String(a)}` : `lines ${String(a)}–${String(b)}`;
/** Where a chunk is: its page (PDFs) or its lines. */
const where = (c: { page: number | null; lineStart: number | null; lineEnd: number | null }) =>
  c.page !== null ? `page ${String(c.page)}` : lines(c.lineStart, c.lineEnd);

/** The parts of these files that best match the question, in file order. */
export async function retrieveExcerpts(
  deps: EmbedDeps & { files: FilesApi },
  model: EmbeddingModel,
  files: readonly FileRecord[],
  question: string,
  threadId: string | null,
): Promise<Excerpts> {
  for (const f of files) await ensureIndexed(deps, model, f);
  const [query] = await embedTexts(
    deps,
    model,
    [question || files.map((f) => f.name).join(", ")],
    threadId,
  );
  if (!query) return { text: "", sources: [] };
  const hits = await nearest(
    deps.db,
    deps.tenant,
    modelKey(model),
    query,
    { kind: "file", ids: files.map((f) => f.id) },
    EXCERPTS,
  );
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
