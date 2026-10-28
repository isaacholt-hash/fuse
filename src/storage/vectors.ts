/** Text chunks and their embeddings (MM-11, FK-02), with nearest-neighbour search. */
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

export type ChunkSource = "file" | "memory" | "message";

export interface NewChunk {
  ordinal: number;
  text: string;
  tokens: number;
  page?: number | null;
  lineStart?: number | null;
  lineEnd?: number | null;
}

export interface Chunk extends Required<NewChunk> {
  id: string;
  sourceKind: ChunkSource;
  sourceId: string;
}

interface ChunkRow {
  id: string;
  source_kind: ChunkSource;
  source_id: string;
  ordinal: number;
  text: string;
  tokens: number;
  page: number | null;
  line_start: number | null;
  line_end: number | null;
}

const toChunk = (r: ChunkRow): Chunk => ({
  id: r.id,
  sourceKind: r.source_kind,
  sourceId: r.source_id,
  ordinal: r.ordinal,
  text: r.text,
  tokens: r.tokens,
  page: r.page,
  lineStart: r.line_start,
  lineEnd: r.line_end,
});

/** Replaces a source's chunks (and their vectors) with these. Returns the new chunk ids in order. */
export async function replaceChunks(
  db: SqlDb,
  tenant: Tenant,
  sourceKind: ChunkSource,
  sourceId: string,
  chunks: readonly NewChunk[],
): Promise<string[]> {
  const ws = tenant.workspaceId;
  await db.execute(
    `DELETE FROM chunk_vectors WHERE workspace_id = ? AND chunk_id IN
       (SELECT id FROM chunks WHERE workspace_id = ? AND source_kind = ? AND source_id = ?)`,
    [ws, ws, sourceKind, sourceId],
  );
  await db.execute(
    `DELETE FROM chunks WHERE workspace_id = ? AND source_kind = ? AND source_id = ?`,
    [ws, sourceKind, sourceId],
  );
  const ids: string[] = [];
  for (const c of chunks) {
    const now = Date.now();
    const id = uuidv7(now);
    await db.execute(
      `INSERT INTO chunks (id, workspace_id, user_id, source_kind, source_id, ordinal, text, tokens,
         page, line_start, line_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        ws,
        tenant.userId,
        sourceKind,
        sourceId,
        c.ordinal,
        c.text,
        c.tokens,
        c.page ?? null,
        c.lineStart ?? null,
        c.lineEnd ?? null,
        now,
        now,
      ],
    );
    ids.push(id);
  }
  return ids;
}

export async function listChunks(
  db: SqlDb,
  tenant: Tenant,
  sourceKind: ChunkSource,
  sourceId: string,
): Promise<Chunk[]> {
  const rows = await db.select<ChunkRow>(
    `SELECT id, source_kind, source_id, ordinal, text, tokens, page, line_start, line_end
     FROM chunks WHERE workspace_id = ? AND source_kind = ? AND source_id = ? ORDER BY ordinal`,
    [tenant.workspaceId, sourceKind, sourceId],
  );
  return rows.map(toChunk);
}

/** Scales a vector to length 1, so a dot product is the cosine similarity. */
export function normalise(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const len = Math.sqrt(sum) || 1;
  return v.map((x) => x / len);
}

/** Float32 vectors as base64 text, little-endian (the byte order of every platform we ship). */
const encode = (v: Float32Array) => {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};
const decode = (s: string) => {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
};

export async function saveVectors(
  db: SqlDb,
  tenant: Tenant,
  model: string,
  items: readonly { chunkId: string; vector: Float32Array }[],
): Promise<void> {
  for (const { chunkId, vector } of items) {
    const now = Date.now();
    await db.execute(
      `INSERT OR REPLACE INTO chunk_vectors (chunk_id, workspace_id, user_id, model, dims, vector,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        chunkId,
        tenant.workspaceId,
        tenant.userId,
        model,
        vector.length,
        encode(normalise(vector)),
        now,
        now,
      ],
    );
  }
}

export interface Match {
  chunk: Chunk;
  /** Cosine similarity, -1 to 1. */
  score: number;
}

/**
 * The chunks most similar to `query` among these sources, best first. A plain scan: a person's
 * own files are thousands of chunks, which a dot product per chunk handles in milliseconds.
 */
export async function nearest(
  db: SqlDb,
  tenant: Tenant,
  model: string,
  query: Float32Array,
  sources: { kind: ChunkSource; ids: readonly string[] },
  limit = 8,
): Promise<Match[]> {
  if (sources.ids.length === 0) return [];
  const rows = await db.select<ChunkRow & { vector: string }>(
    `SELECT c.id, c.source_kind, c.source_id, c.ordinal, c.text, c.tokens, c.page, c.line_start,
            c.line_end, v.vector
     FROM chunks c JOIN chunk_vectors v ON v.chunk_id = c.id AND v.model = ?
     WHERE c.workspace_id = ? AND c.source_kind = ?
       AND c.source_id IN (${sources.ids.map(() => "?").join(", ")})`,
    [model, tenant.workspaceId, sources.kind, ...sources.ids],
  );
  const q = normalise(query);
  return rows
    .map((r) => {
      const v = decode(r.vector);
      let dot = 0;
      for (let i = 0; i < Math.min(v.length, q.length); i++) dot += (v[i] ?? 0) * (q[i] ?? 0);
      return { chunk: toChunk(r), score: dot };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Chunks of these sources that have no vector for `model` yet. */
export async function unembedded(
  db: SqlDb,
  tenant: Tenant,
  model: string,
  kind: ChunkSource,
  ids: readonly string[],
): Promise<Chunk[]> {
  if (ids.length === 0) return [];
  const rows = await db.select<ChunkRow>(
    `SELECT c.id, c.source_kind, c.source_id, c.ordinal, c.text, c.tokens, c.page, c.line_start,
            c.line_end
     FROM chunks c LEFT JOIN chunk_vectors v ON v.chunk_id = c.id AND v.model = ?
     WHERE c.workspace_id = ? AND c.source_kind = ? AND v.chunk_id IS NULL
       AND c.source_id IN (${ids.map(() => "?").join(", ")})
     ORDER BY c.source_id, c.ordinal`,
    [model, tenant.workspaceId, kind, ...ids],
  );
  return rows.map(toChunk);
}
