// @vitest-environment node
import { defaultCatalog } from "@/catalog/defaultCatalog";
import type { ProviderAdapter } from "@/providers/types";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { listRecentRequests } from "@/storage/requestLog";
import { openTestDb } from "@/storage/testing/nodeDb";
import { listChunks, nearest, replaceChunks } from "@/storage/vectors";
import { chunkText } from "./chunk";
import { embeddingModel, indexChunks, modelKey } from "./embed";

const t = DEFAULT_TENANT;

test("chunks follow lines, stay near the budget, overlap a little and keep line numbers", () => {
  const text = Array.from(
    { length: 100 },
    (_, i) => `Line ${String(i + 1)} ${"x".repeat(60)}`,
  ).join("\n");
  const chunks = chunkText(text, 200);
  expect(chunks.length).toBeGreaterThan(5);
  expect(chunks[0]).toMatchObject({ ordinal: 0, lineStart: 1 });
  expect(chunks.every((c) => c.tokens <= 220)).toBe(true);
  expect((chunks[1]?.lineStart ?? 0) <= (chunks[0]?.lineEnd ?? 0)).toBe(true); // overlap
  expect(chunks.at(-1)?.lineEnd).toBe(100);
  // One enormous line is cut by characters.
  expect(chunkText("y".repeat(10_000), 200).length).toBeGreaterThan(5);
  expect(chunkText("  \n \n")).toEqual([]);
});

test("the cheapest embedding model from a provider with a key; none without OpenAI", () => {
  expect(embeddingModel(defaultCatalog, ["anthropic", "openai"])?.id).toBe(
    "text-embedding-3-small",
  );
  expect(embeddingModel(defaultCatalog, ["anthropic"])).toBeNull();
});

test("indexing embeds only new chunks, logs the cost, and nearest finds the closest", async () => {
  const db = openTestDb();
  // A toy embedding: counts of a, b and c.
  const vec = (s: string) => Float32Array.from(["a", "b", "c"].map((ch) => s.split(ch).length - 1));
  const calls: string[][] = [];
  const openai: ProviderAdapter = {
    provider: "openai",
    listModels: () => Promise.resolve([]),
    streamChat: () => {
      throw new Error("not used");
    },
    embed: (texts) => {
      calls.push(texts);
      return Promise.resolve({
        vectors: texts.map(vec),
        tokens: texts.join("").length,
        providerRequestId: "req_e",
        attempts: 1,
      });
    },
  };
  const model = embeddingModel(defaultCatalog, ["openai"]);
  if (!model) throw new Error("no model");
  const deps = { db, tenant: t, priceVersion: "2026-10-28", adapterFor: () => openai };
  await replaceChunks(db, t, "file", "f1", [
    { ordinal: 0, text: "aaaa", tokens: 1 },
    { ordinal: 1, text: "bbbb", tokens: 1 },
    { ordinal: 2, text: "cccc", tokens: 1 },
  ]);
  expect(await indexChunks(deps, model, "file", ["f1"])).toBe(3);
  expect(await indexChunks(deps, model, "file", ["f1"])).toBe(0);
  expect(calls).toHaveLength(1);
  const log = (await listRecentRequests(db, t, 5))[0];
  expect(log).toMatchObject({ purpose: "embed", model: "text-embedding-3-small" });

  const hits = await nearest(db, t, modelKey(model), vec("bb a"), {
    kind: "file",
    ids: ["f1"],
  });
  expect(hits.map((h) => h.chunk.text)).toEqual(["bbbb", "aaaa", "cccc"]);
  expect(hits[0]?.score).toBeCloseTo(2 / Math.sqrt(5), 5);

  // Replacing a source's chunks drops their old vectors.
  await replaceChunks(db, t, "file", "f1", [{ ordinal: 0, text: "cc", tokens: 1 }]);
  expect((await listChunks(db, t, "file", "f1")).map((c) => c.text)).toEqual(["cc"]);
  expect(await nearest(db, t, modelKey(model), vec("c"), { kind: "file", ids: ["f1"] })).toEqual(
    [],
  );
});
