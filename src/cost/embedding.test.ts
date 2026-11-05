// @vitest-environment node
import type { EmbeddingModel } from "@/catalog/catalog";
import { createOpenAIAdapter } from "@/providers/openai/adapter";
import { ProviderError } from "@/providers/errors";
import type { ProviderAdapter } from "@/providers/types";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { listRecentRequests } from "@/storage/requestLog";
import { createRun, getRun } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { embeddingBound, trackedEmbedding } from "./embedding";

// Synthetic price/dimensions make exact cost and cap assertions readable.
const model: EmbeddingModel = {
  provider: "openai",
  id: "recorded-embedding",
  dimensions: 2,
  maxInputTokens: 1000,
  inputPrice: 1,
  verifiedOn: "2026-11-05",
  sourceUrl: "https://example.invalid/recorded-pricing",
};
const adapter = (embed: NonNullable<ProviderAdapter["embed"]>): ProviderAdapter => ({
  provider: "openai",
  listModels: () => Promise.resolve([]),
  streamChat() {
    throw new Error("Embedding only");
  },
  embed,
});
const successful = () => ({
  vectors: [Float32Array.of(1, 0)],
  tokens: 10,
  usageReported: true,
  attempts: 1,
  providerRequestId: "recorded-embedding-request",
});
async function setup(capMicroUsd = 2000) {
  const db = openTestDb();
  const run = await createRun(db, tenant, {
    projectId: null,
    threadId: null,
    messageId: null,
    task: "Recorded retrieval",
    provider: "openai",
    model: model.id,
    capMicroUsd,
  });
  return {
    db,
    run,
    deps: { db, tenant, priceVersion: "recorded" },
    context: { runId: run.id, threadId: null, messageId: null },
  };
}

test("embedding holds reserve the full catalog allowance and settle one integer charge", async () => {
  const { db, run, deps, context } = await setup();
  const embed = vi.fn(async (_texts, _model, _signal, _scope, options) => {
    expect(options).toEqual({ noRetry: true });
    const rows = await db.select<{ state: string }>("SELECT state FROM request_reservations");
    expect(rows).toEqual([{ state: "dispatched" }]);
    return successful();
  }) as NonNullable<ProviderAdapter["embed"]>;
  expect(embeddingBound(model, ["small input"])).toBe(1000);
  await trackedEmbedding(deps, adapter(embed), model, ["small input"], context);
  const rows = await listRecentRequests(db, tenant);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    purpose: "embed",
    billingState: "reported",
    usage: { costMicroUsd: 10 },
  });
  expect((await getRun(db, tenant, run.id))?.spentMicroUsd).toBe(10);
  expect(await db.select("SELECT state FROM request_reservations")).toEqual([{ state: "settled" }]);
});

test("concurrent retrievals share the cap before dispatch, without duplicate costs", async () => {
  const { db, run, deps, context } = await setup();
  const embed = vi.fn(() => Promise.resolve(successful()));
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      trackedEmbedding(deps, adapter(embed), model, ["query"], context),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  expect(embed).toHaveBeenCalledTimes(2);
  expect((await getRun(db, tenant, run.id))?.spentMicroUsd).toBe(20);
});

test("a cap refusal or cancellation before dispatch makes no provider attempt", async () => {
  const { deps, context, db } = await setup(1);
  const embed = vi.fn(() => Promise.resolve(successful()));
  await expect(
    trackedEmbedding(deps, adapter(embed), model, ["query"], context),
  ).rejects.toMatchObject({ code: "request_cap" });
  const controller = new AbortController();
  controller.abort();
  await expect(
    trackedEmbedding(
      deps,
      adapter(embed),
      model,
      ["query"],
      { ...context, runId: null },
      controller.signal,
    ),
  ).rejects.toMatchObject({ kind: "aborted" });
  expect(embed).not.toHaveBeenCalled();
  expect(await listRecentRequests(db, tenant)).toEqual([]);
  expect(await db.select("SELECT state FROM request_reservations")).toEqual([
    { state: "released" },
  ]);
});

test("a lost response makes one HTTP attempt and preserves unresolved exposure", async () => {
  const { db, deps, context } = await setup();
  const fetch = vi.fn(() =>
    Promise.reject(new Error("Private returned text must not enter the audit")),
  );
  const connection = createOpenAIAdapter({ fetch, retry: { sleep: () => Promise.resolve() } });
  await expect(trackedEmbedding(deps, connection, model, ["query"], context)).rejects.toMatchObject(
    { billingUncertain: true },
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const rows = await listRecentRequests(db, tenant);
  expect(rows[0]).toMatchObject({ billingState: "unknown", attempt: 1 });
  expect(JSON.stringify(rows)).not.toContain("Private returned text");
  expect(await db.select("SELECT state,bound_micro_usd FROM request_reservations")).toEqual([
    { state: "unknown", bound_micro_usd: 1000 },
  ]);
});

test("missing usage stays unresolved while usable vectors require no paid retry", async () => {
  const { db, deps, context } = await setup();
  const embed = vi.fn(() => Promise.resolve({ ...successful(), tokens: 0, usageReported: false }));
  const result = await trackedEmbedding(deps, adapter(embed), model, ["query"], context);
  expect(result.usageReported).toBe(false);
  expect(embed).toHaveBeenCalledTimes(1);
  expect((await listRecentRequests(db, tenant))[0]?.billingState).toBe("unknown");
});

test("malformed vectors retain the incurred charge; known rejection releases unused exposure", async () => {
  const { db, deps, context, run } = await setup();
  await expect(
    trackedEmbedding(
      deps,
      adapter(() =>
        Promise.resolve({ ...successful(), vectors: [Float32Array.of(Number.NaN, 0)] }),
      ),
      model,
      ["query"],
      context,
    ),
  ).rejects.toMatchObject({ kind: "stream" });
  expect((await getRun(db, tenant, run.id))?.spentMicroUsd).toBe(10);
  expect((await listRecentRequests(db, tenant))[0]?.billingState).toBe("reported");
  await expect(
    trackedEmbedding(
      deps,
      adapter(() =>
        Promise.reject(new ProviderError("auth", "Recorded rejection", { status: 401 })),
      ),
      model,
      ["query"],
      context,
    ),
  ).rejects.toMatchObject({ billingUncertain: false });
  expect((await listRecentRequests(db, tenant)).some((r) => r.billingState === "not_billed")).toBe(
    true,
  );
  expect(
    await db.select(
      "SELECT state FROM request_reservations WHERE state IN('held','dispatched','unknown')",
    ),
  ).toEqual([]);
});

test("local models, unpriced/oversized inputs and invalid dimensions are refused before dispatch", () => {
  expect(() => embeddingBound({ ...model, provider: "local" }, ["query"])).toThrow();
  expect(() => embeddingBound({ ...model, inputPrice: Number.NaN }, ["query"])).toThrow();
  expect(() => embeddingBound({ ...model, dimensions: 0 }, ["query"])).toThrow();
  expect(() => embeddingBound(model, ["x".repeat(1001)])).toThrow();
  expect(() => embeddingBound(model, [])).toThrow();
});

test("the real adapter preserves valid usage from malformed or duplicated embedding rows", async () => {
  for (const data of [
    null,
    [{ index: 0, embedding: ["invalid"] }],
    [{ index: 1, embedding: [1, 0] }],
  ]) {
    const { db, deps, context } = await setup();
    const fetch = vi.fn(() =>
      Promise.resolve(
        Response.json(
          { data, usage: { prompt_tokens: 10 } },
          { headers: { "x-request-id": "recorded-malformed" } },
        ),
      ),
    );
    const connection = createOpenAIAdapter({ fetch });
    await expect(
      trackedEmbedding(deps, connection, model, ["query"], context),
    ).rejects.toMatchObject({ kind: "stream", billingUncertain: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await listRecentRequests(db, tenant))[0]).toMatchObject({
      billingState: "reported",
      providerRequestId: "recorded-malformed",
      usage: { costMicroUsd: 10 },
    });
  }
});
