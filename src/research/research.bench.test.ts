// @vitest-environment node
/** Recorded synthetic benchmark. No live provider, key or production installation is used. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultCatalog as catalog } from "@/catalog/defaultCatalog";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { tierOf } from "@/routing/policy";
import { openTestDb } from "@/storage/testing/nodeDb";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { createThread } from "@/storage/threads";
import { uuidv7 } from "@/storage/ids";
import { listArtifacts } from "@/storage/artifacts";
import { listMessages } from "@/storage/messages";
import { listRecentRequests } from "@/storage/requestLog";
import { runExposure } from "@/storage/requestBudget";
import { markInterruptedRuns } from "@/storage/runs";
import { startResearchRun, continueResearchRun } from "./engine";
import { checkpoint } from "./storage";
import { researchModels } from "./routing";
import { scriptedResearchWeb } from "./testing/scripted";
import { recordedResearchAdapters } from "./testing/recorded";

const OUT = process.env.FUSE_RESEARCH_BENCH_OUTPUT;
const results: Record<string, unknown>[] = [];
const started = performance.now();
async function fixture(
  provider: "openai" | "anthropic",
  options: Parameters<typeof recordedResearchAdapters>[0] = {},
) {
  const db = openTestDb(),
    thread = await createThread(db, tenant, "Research benchmark");
  const models = researchModels(
    catalog,
    defaultPolicy,
    { kind: "auto" },
    "Compare recorded measurements",
    ["openai", "anthropic"],
  );
  const best = catalog.models.find(
    (m) => m.provider === provider && tierOf(defaultPolicy, m) === "best",
  );
  if (!best) throw new Error("Missing benchmark Best model");
  const recorded = recordedResearchAdapters(options);
  const deps = { db, tenant, catalog, adapterFor: recorded.adapterFor, web: scriptedResearchWeb() };
  const input = {
    requestId: uuidv7(),
    threadId: thread.id,
    task: "Compare recorded measurements",
    worker: models.worker,
    best,
    capMicroUsd: 5_000_000,
    location: "desktop" as const,
  };
  return { db, thread, recorded, deps, input };
}

describe.skipIf(!OUT)("recorded research benchmark", () => {
  test.each(["openai", "anthropic"] as const)(
    "real %s text adapter with bounded OpenAI search, citations and hostile-source exclusion",
    async (provider) => {
      const { db, thread, recorded, deps, input } = await fixture(provider);
      const run = await startResearchRun(deps, input);
      expect(run.status).toBe("done");
      expect(recorded.calls.map((c) => c.stage)).toEqual(["plan", "search", "synthesis", "verify"]);
      expect(recorded.calls.filter((c) => c.stage !== "search").map((c) => c.provider)).toEqual([
        provider,
        provider,
        provider,
      ]);
      expect(recorded.calls[1]?.provider).toBe("openai");
      expect(JSON.parse(recorded.calls[1]?.body ?? "{}")).toMatchObject({
        max_tool_calls: 1,
        store: false,
        max_output_tokens: 4000,
      });
      expect(recorded.calls[2]?.body).not.toContain("Ignore previous instructions");
      const artifact = (await listArtifacts(db, tenant, thread.id))[0];
      expect(artifact?.content).toContain("[S1](https://research-fixture.example/source)");
      expect(artifact?.content).toContain("**Unverified:** An unsupported synthetic assertion.");
      expect(artifact?.content).toContain("hostile instructions flagged");
      const receipts = await listRecentRequests(db, tenant);
      expect(receipts).toHaveLength(4);
      expect(receipts.reduce((sum, r) => sum + r.usage.costMicroUsd, 0)).toBe(run.spentMicroUsd);
      expect((await listMessages(db, tenant, thread.id)).at(-1)?.usage).toMatchObject({
        inputTokens: 4000,
        outputTokens: 400,
        webSearchCalls: 1,
        costMicroUsd: run.spentMicroUsd,
      });
      await startResearchRun(deps, input);
      await continueResearchRun(deps, run.id);
      expect(recorded.calls).toHaveLength(4);
      expect(await db.select("SELECT id FROM folders")).toEqual([]);
      expect(await db.select("SELECT id FROM run_changes")).toEqual([]);
      results.push({
        scenario: `${provider} Best stages; OpenAI bounded search`,
        status: run.status,
        requests: 4,
        costMicroUsd: run.spentMicroUsd,
        verifiedCitations: 1,
        unverifiedClaims: 1,
        hostileInstructionsExcluded: true,
      });
    },
  );
  test("cap exhaustion dispatches nothing; explicit continuation reserves once", async () => {
    const { recorded, deps, input, db } = await fixture("anthropic");
    const paused = await startResearchRun(deps, { ...input, capMicroUsd: 1 });
    expect(paused.status).toBe("paused");
    expect(recorded.calls).toHaveLength(0);
    expect((await checkpoint(deps, paused.id)).state.modelCalls).toBe(0);
    const done = await continueResearchRun(deps, paused.id, { capMicroUsd: 5_000_000 });
    expect(done.status).toBe("done");
    expect(recorded.calls).toHaveLength(4);
    expect(await listRecentRequests(db, tenant)).toHaveLength(4);
    results.push({
      scenario: "cap exhaustion and explicit continuation",
      blockedRequests: 1,
      providerRequestsBeforeConfirmation: 0,
      completedRequests: 4,
      costMicroUsd: done.spentMicroUsd,
    });
  });
  test("ambiguous search billing remains unresolved and its paid search is never replayed", async () => {
    const { db, deps, input, recorded } = await fixture("anthropic", { ambiguousAt: 2 });
    const paused = await startResearchRun(deps, input);
    expect(paused.status).toBe("paused");
    expect((await runExposure(db, tenant, paused.id)).held).toBeGreaterThan(0);
    await continueResearchRun(deps, paused.id);
    expect(recorded.calls.filter((c) => c.stage === "search")).toHaveLength(1);
    const rows = await listRecentRequests(db, tenant);
    expect(rows.filter((r) => r.billingState === "unknown")).toHaveLength(1);
    expect((await runExposure(db, tenant, paused.id)).held).toBeGreaterThan(0);
    results.push({
      scenario: "ambiguous billed search",
      searchAttempts: 1,
      replayedAttempts: 0,
      unknownBillingRows: 1,
      heldMicroUsd: (await runExposure(db, tenant, paused.id)).held,
    });
  });
  test("desktop interruption retains checkpoints; startup does not execute; continuation is explicit", async () => {
    const controller = new AbortController();
    const { db, recorded, deps, input } = await fixture("openai", {
      onCall: (_call, index) => {
        if (index === 2) controller.abort();
      },
    });
    const stopped = await startResearchRun(deps, input, controller.signal);
    expect(stopped.status).toBe("stopped");
    const attempts = recorded.calls.length;
    await markInterruptedRuns(db, tenant);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(recorded.calls).toHaveLength(attempts);
    await continueResearchRun(deps, stopped.id);
    expect(recorded.calls.filter((c) => c.stage === "search")).toHaveLength(1);
    results.push({
      scenario: "interrupted desktop and explicit continuation",
      automaticRequestsAfterStartup: 0,
      replayedSearchAttempts: 0,
      requests: recorded.calls.length,
    });
  });
  test("a seeded hard boundary emits a partial report without another model call", async () => {
    const { deps, input, db, recorded } = await fixture("anthropic");
    const paused = await startResearchRun(deps, { ...input, capMicroUsd: 1 });
    const state = (await checkpoint(deps, paused.id)).state;
    await db.execute("UPDATE research_state SET data=? WHERE run_id=?", [
      JSON.stringify({ ...state, modelCalls: 30 }),
      paused.id,
    ]);
    const partial = await continueResearchRun(deps, paused.id, { capMicroUsd: 5_000_000 });
    expect(partial.status).toBe("stopped");
    expect((await checkpoint(deps, paused.id)).state.stage).toBe("finished");
    expect(recorded.calls).toHaveLength(0);
    expect((await listMessages(db, tenant, input.threadId)).at(-1)?.content).toContain(
      "Partial research result.",
    );
    results.push({
      scenario: "model-call limit boundary fixture",
      limit: 30,
      additionalProviderRequests: 0,
      partial: true,
    });
  });
  afterAll(() => {
    if (!OUT) return;
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          benchmark: "M14 recorded research",
          synthetic: true,
          liveProviderCalls: 0,
          priceVersion: catalog.priceVersion,
          limits: { searches: 12, sources: 24, modelCalls: 30, activeMinutes: 30 },
          elapsedMs: Math.round(performance.now() - started),
          results,
        },
        null,
        2,
      ) + "\n",
    );
    expect(results).toHaveLength(6);
  });
});
