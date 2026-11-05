/** Bounded meaning retrieval with explicit keyword fallback and immutable source references. */
import type { EmbeddingModel, Catalog, ProviderId } from "@/catalog/catalog";
import { trackedEmbedding } from "@/cost/embedding";
import { modelKey } from "@/knowledge/embed";
import { keywords } from "@/memory/inject";
import { findSecretInFile } from "@/memory/secrets";
import type { ProviderAdapter } from "@/providers/types";
import { uuidv7 } from "@/storage/ids";
import { requireContext, scopedArtifacts, type ContextDb, type ContextOwner } from "./access";
import { artifactReference } from "./artifactTools";
import { allowedEmbedding, threadPolicy } from "./egress";

export interface ArtifactSearchDeps extends ContextDb {
  catalog: Catalog;
  adapterFor(provider: ProviderId): ProviderAdapter;
}
const sample = (text: string, bytes: number) => {
  // At most bytes UTF-8 bytes, never a broken multibyte sequence.
  let out = "",
    used = 0;
  for (const c of text) {
    const n = new TextEncoder().encode(c).length;
    if (used + n > bytes) break;
    out += c;
    used += n;
  }
  return out;
};
async function digest(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
function similarity(
  a: readonly number[] | Float32Array,
  b: readonly number[] | Float32Array,
): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0,
      y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa && bb ? Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb))) : 0;
}
function decode(raw: string, dims: number): number[] | null {
  try {
    const x: unknown = JSON.parse(raw);
    return Array.isArray(x) &&
      x.length === dims &&
      x.every((v) => typeof v === "number" && Number.isFinite(v))
      ? (x as number[])
      : null;
  } catch {
    return null;
  }
}
export async function findArtifacts(
  deps: ArtifactSearchDeps,
  owner: ContextOwner,
  query: string,
  {
    meaning = false,
    embedding,
    signal,
  }: { meaning?: boolean; embedding?: EmbeddingModel | null; signal?: AbortSignal } = {},
) {
  const guard = await requireContext(deps, owner, "search_artifacts");
  if (!query.trim() || query.length > 2000 || findSecretInFile(query))
    throw new Error("Use a non-secret search query of up to 2,000 characters.");
  const { db, tenant } = deps;
  const all = (await scopedArtifacts(deps, owner)).filter(
    (a) =>
      a.totalCharacters <= 100000 &&
      !findSecretInFile(`${a.title}\n${a.threadTitle}\n${a.content}`),
  );
  const words = keywords(query),
    scores = new Map<string, number>(),
    byMeaning = new Map<string, number>();
  for (const a of all) {
    const contentWords = keywords(`${a.title}\n${a.content}`);
    scores.set(a.id, [...words].filter((w) => contentWords.has(w)).length);
  }
  let mode: "keyword" | "meaning" = "keyword",
    notice = meaning
      ? "Meaning search is unavailable; keyword fallback was used."
      : "Keyword search.";
  let billing: "none" | "reported" | "unresolved" = "none";
  const chosen = allowedEmbedding(await threadPolicy(db, tenant, owner.threadId), embedding);
  if (meaning && chosen && all.length) {
    // A call identity is claimed before any paid request: retrying an interrupted tool never
    // starts a second embedding attempt. Only content-free metadata is retained here.
    const now = Date.now(),
      claim = await db.batch([
        {
          sql: `INSERT OR IGNORE INTO context_tool_audit(id,workspace_id,user_id,thread_id,run_id,message_id,call_key,tool_name,record_kind,outcome,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,'search_artifacts','artifact','read',?,? WHERE ${guard.sql}`,
          params: [
            uuidv7(),
            tenant.workspaceId,
            tenant.userId,
            owner.threadId,
            owner.runId,
            owner.messageId,
            owner.callKey,
            now,
            now,
            ...guard.params,
          ],
        },
      ]);
    if (claim[0]?.rowsAffected) {
      try {
        const candidates = all.slice(0, 16),
          key = modelKey(chosen),
          bytes = Math.min(chosen.maxInputTokens, 4000);
        const data = await Promise.all(
          candidates.map(async (a) => {
            const text = sample(`${a.title}\n${a.content}`, bytes);
            return { a, text, hash: await digest(text) };
          }),
        );
        const cached = await db.select<{
          version_id: string;
          source_hash: string;
          vector: string;
          dims: number;
        }>(
          `SELECT version_id,source_hash,vector,dims FROM artifact_vectors WHERE workspace_id=? AND user_id=? AND model=? AND version_id IN (${data.map(() => "?").join(",")})`,
          [tenant.workspaceId, tenant.userId, key, ...data.map((d) => d.a.versionId)],
        );
        const vectors = new Map<string, readonly number[]>();
        for (const d of data) {
          const c = cached.find(
            (c) =>
              c.version_id === d.a.versionId &&
              c.source_hash === d.hash &&
              c.dims === chosen.dimensions,
          );
          const v = c ? decode(c.vector, c.dims) : null;
          if (v) vectors.set(d.a.id, v);
        }
        const missing = data.filter((d) => !vectors.has(d.a.id));
        // Fresh policies/source versions are checked after indexing reads and before dispatch.
        await requireContext(deps, { ...owner, provider: chosen.provider }, "search_artifacts");
        if (!allowedEmbedding(await threadPolicy(db, tenant, owner.threadId), chosen))
          throw new Error("Embedding permission changed.");
        const fresh = await scopedArtifacts(deps, owner);
        if (data.some((d) => !fresh.some((a) => a.id === d.a.id && a.versionId === d.a.versionId)))
          throw new Error("Artifact scope changed.");
        const result = await trackedEmbedding(
          { ...deps, priceVersion: deps.catalog.priceVersion },
          deps.adapterFor(chosen.provider),
          chosen,
          [sample(query, bytes), ...missing.map((d) => d.text)],
          {
            runId: owner.runId,
            threadId: owner.threadId,
            messageId: owner.messageId,
            projectId: owner.projectId,
          },
          signal,
        );
        billing = result.usageReported ? "reported" : "unresolved";
        const q = result.vectors[0];
        if (!q) throw new Error("Missing query vector.");
        await requireContext(deps, owner, "search_artifacts");
        const embeddingGuard = await requireContext(
          deps,
          { ...owner, provider: chosen.provider },
          "search_artifacts",
        );
        if (!allowedEmbedding(await threadPolicy(db, tenant, owner.threadId), chosen))
          throw new Error("Embedding policy changed.");
        const freshAfter = await scopedArtifacts(deps, owner);
        const inserts = [];
        for (const [i, d] of missing.entries()) {
          const v = result.vectors[i + 1];
          if (!v) continue;
          if (!freshAfter.some((a) => a.id === d.a.id && a.versionId === d.a.versionId)) continue;
          vectors.set(d.a.id, Array.from(v));
          inserts.push({
            sql: `INSERT OR REPLACE INTO artifact_vectors(workspace_id,user_id,artifact_id,version_id,model,source_hash,dims,vector,created_at,updated_at)
            SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${embeddingGuard.sql}
              AND EXISTS(SELECT 1 FROM threads et LEFT JOIN projects ep ON ep.id=et.project_id AND ep.workspace_id=et.workspace_id
                WHERE et.id=? AND (et.project_id IS NULL OR ep.allow_embeddings=1))
              AND EXISTS(SELECT 1 FROM artifacts a JOIN artifact_versions v ON v.artifact_id=a.id
              WHERE a.id=? AND a.deleted_at IS NULL AND v.id=? AND v.id=(SELECT id FROM artifact_versions WHERE artifact_id=a.id ORDER BY version DESC,id DESC LIMIT 1))`,
            params: [
              tenant.workspaceId,
              tenant.userId,
              d.a.id,
              d.a.versionId,
              key,
              d.hash,
              chosen.dimensions,
              JSON.stringify(Array.from(v)),
              now,
              now,
              ...embeddingGuard.params,
              owner.threadId,
              d.a.id,
              d.a.versionId,
            ],
          });
        }
        if (inserts.length) await db.batch(inserts);
        for (const d of data) {
          const v = vectors.get(d.a.id);
          if (v) byMeaning.set(d.a.id, similarity(q, v));
        }
        mode = "meaning";
        notice =
          "Meaning search covers the title and up to the first 4,000 UTF-8 bytes of up to 16 recent artifacts. Keywords cover full text of up to 200 recent artifacts; older or over-100,000-character records are outside this bounded search.";
      } catch {
        notice =
          "Meaning retrieval did not complete. Keyword fallback was used; no paid retry was made. Check Usage for any unresolved charge.";
        const [uncertain] = await db.select<{ n: number }>(
          "SELECT COUNT(*) AS n FROM request_reservations WHERE workspace_id=? AND user_id=? AND thread_id=? AND state='unknown'",
          [tenant.workspaceId, tenant.userId, owner.threadId],
        );
        if (uncertain?.n) billing = "unresolved";
      }
    } else
      notice =
        "This search turn was already attempted. Keyword fallback avoids a duplicate paid request.";
  }
  await requireContext(deps, owner, "search_artifacts");
  const final = await scopedArtifacts(deps, owner);
  const hits = all
    .filter((a) => final.some((f) => f.id === a.id && f.versionId === a.versionId))
    .map((a) => ({ a, semantic: byMeaning.get(a.id) ?? 0, word: scores.get(a.id) ?? 0 }))
    .filter((h) => h.word > 0 || h.semantic > 0.3)
    .sort(
      (a, b) =>
        b.word + Math.max(0, b.semantic - 0.3) * 6 - (a.word + Math.max(0, a.semantic - 0.3) * 6) ||
        b.a.updatedAt - a.a.updatedAt ||
        a.a.id.localeCompare(b.a.id),
    )
    .slice(0, 8);
  return {
    mode,
    billing,
    notice,
    coverage: {
      recentArtifacts: all.length,
      maximumArtifacts: 200,
      semanticMaximum: 16,
      sampleBytes: 4000,
    },
    results: hits.map((h) => ({
      ...artifactReference(h.a),
      excerpt: h.a.content.slice(0, 900),
      reason: h.semantic > 0.3 ? "meaning" : "keyword",
    })),
  };
}
