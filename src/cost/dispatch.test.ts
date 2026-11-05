// @vitest-environment node
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { createAnthropicAdapter } from "@/providers/anthropic/adapter";
import { ProviderError } from "@/providers/errors";
import type { ProviderAdapter, StreamEvent } from "@/providers/types";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { createRun, getRun } from "@/storage/runs";
import { listRecentRequests } from "@/storage/requestLog";
import { runExposure } from "@/storage/requestBudget";
import { openTestDb } from "@/storage/testing/nodeDb";
import { requestBound, trackedChat } from "./dispatch";

const model = defaultCatalog.models.find((m) => m.provider === "anthropic");
if (!model) throw new Error("Missing fixture model");
const fixtureModel = model;
async function setup(capMicroUsd = 1_000_000) {
  const db = openTestDb();
  const run = await createRun(db, tenant, {
    projectId: null,
    threadId: null,
    messageId: null,
    task: "Fixture",
    provider: fixtureModel.provider,
    model: fixtureModel.id,
    capMicroUsd,
  });
  const context = { runId: run.id, purpose: "agent" as const, threadId: null, messageId: null };
  return { db, run, context, deps: { db, tenant, catalog: defaultCatalog } };
}
const read = async (events: AsyncIterable<StreamEvent>) => {
  const collected: StreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

test("an insufficient cap stops before any provider call", async () => {
  const { deps, context, db } = await setup(1);
  let calls = 0;
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    async *streamChat() {
      calls++;
      await Promise.resolve();
      yield { type: "text", text: "Unexpected paid call" };
    },
  };
  await expect(
    read(
      trackedChat(deps, adapter, fixtureModel, [{ role: "user", content: "Hello" }], {}, context),
    ),
  ).rejects.toMatchObject({ code: "request_cap" });
  expect(calls).toBe(0);
  expect(await listRecentRequests(db, tenant)).toEqual([]);
});

test("a lost HTTP response is not retried, keeps its bound and has an unknown receipt", async () => {
  const { deps, context, db, run } = await setup();
  let calls = 0;
  const adapter = createAnthropicAdapter({
    fetch: () => {
      calls++;
      return Promise.reject(new Error("lost connection"));
    },
    retry: { sleep: async () => {} },
  });
  await expect(
    read(
      trackedChat(deps, adapter, fixtureModel, [{ role: "user", content: "Hello" }], {}, context),
    ),
  ).rejects.toBeInstanceOf(ProviderError);
  expect(calls).toBe(1);
  const [receipt] = await listRecentRequests(db, tenant);
  expect(receipt).toMatchObject({ attempt: 1, billingState: "unknown" });
  expect((await runExposure(db, tenant, run.id)).held).toBeGreaterThan(0);
  expect((await getRun(db, tenant, run.id))?.spentMicroUsd).toBe(0);
});

test("a proven non-billable refusal releases its hold", async () => {
  const { deps, context, db, run } = await setup();
  const adapter = createAnthropicAdapter({
    fetch: () =>
      Promise.resolve(
        new Response('{"error":{"type":"rate_limit_error","message":"busy"}}', {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      ),
  });
  await expect(
    read(
      trackedChat(deps, adapter, fixtureModel, [{ role: "user", content: "Hello" }], {}, context),
    ),
  ).rejects.toMatchObject({ status: 429 });
  expect((await runExposure(db, tenant, run.id)).held).toBe(0);
  expect((await listRecentRequests(db, tenant))[0]?.billingState).toBe("not_billed");
});

test("abandoning a stream retains exposure; malformed usage never becomes a zero charge", async () => {
  for (const malformed of [false, true]) {
    const { deps, context, db, run } = await setup();
    const adapter: ProviderAdapter = {
      provider: "anthropic",
      listModels: () => Promise.resolve([]),
      async *streamChat() {
        await Promise.resolve();
        yield { type: "text", text: "Partial" };
        yield {
          type: "done",
          usage: {
            inputTokens: -1,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            webSearchCalls: 0,
          },
          usageReported: true,
          stopReason: null,
          providerRequestId: null,
          attempts: 1,
        };
      },
    };
    const stream = trackedChat(
      deps,
      adapter,
      fixtureModel,
      [{ role: "user", content: "Hello" }],
      {},
      context,
    );
    if (malformed) await expect(read(stream)).rejects.toMatchObject({ kind: "stream" });
    else {
      await stream.next();
      await stream.return(undefined);
    }
    expect((await runExposure(db, tenant, run.id)).held).toBeGreaterThan(0);
    expect((await listRecentRequests(db, tenant))[0]?.billingState).toBe("unknown");
  }
});

test("byte bounds include UTF-8 and cache-write rates; media falls back to full context", () => {
  const options = { maxOutputTokens: 100 };
  expect(
    requestBound(fixtureModel, [{ role: "user", content: "汉".repeat(100) }], options),
  ).toBeGreaterThan(
    requestBound(fixtureModel, [{ role: "user", content: "a".repeat(100) }], options),
  );
  expect(
    requestBound(
      fixtureModel,
      [
        {
          role: "user",
          content: "",
          attachments: [{ kind: "pdf", name: "fixture.pdf", data: "AA==" }],
        },
      ],
      options,
    ),
  ).toBeGreaterThan(requestBound(fixtureModel, [{ role: "user", content: "Hello" }], options));
});
