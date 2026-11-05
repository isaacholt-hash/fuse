// @vitest-environment node
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createProject, setProjectRepo, setProjectPrivacy } from "@/storage/projects";
import { createThread } from "@/storage/threads";
import { addMemory } from "@/storage/memories";
import { uuidv7 } from "@/storage/ids";
import type { SqlValue, SqlStatement } from "@/storage/sql";
import type { HulkApi, HulkStatus } from "@/handover/api";
import { getRequest } from "@/storage/runQueue";
import { getRun } from "@/storage/runs";
import { listRecentRequests } from "@/storage/requestLog";
import type { ProviderAdapter, StreamEvent } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import { Runner } from "@/runner/runner";
import { researchModels } from "./routing";
import { captureTransfer, readTransfer } from "./transfer";
import { EMPTY_SELECTION } from "./types";
import { startRemoteResearch, remoteResearchLinks, remoteResearchStatus } from "./remote";

const models = researchModels(defaultCatalog, defaultPolicy, { kind: "auto" }, "Compare tides", [
  "openai",
  "anthropic",
]);
async function setup() {
  const source = openTestDb(),
    target = openTestDb(),
    project = await createProject(source, tenant, "Research project");
  const thread = await createThread(source, tenant, "Original Chat", project.id);
  await target.execute(
    "INSERT INTO projects(id,workspace_id,user_id,name,instructions,created_at,updated_at) VALUES(?,?,?,?,?,1,1)",
    [
      project.id,
      tenant.workspaceId,
      tenant.userId,
      "Existing HULK project",
      "HULK instructions stay here",
    ],
  );

  await setProjectRepo(source, tenant, project.id, {
    root: "/fixture/machine-specific",
    readSecrets: false,
  });
  const chosen = await addMemory(source, tenant, {
    text: "EXPLICIT SELECTED CONTEXT",
    kind: "fact",
    projectId: project.id,
  });
  await addMemory(source, tenant, {
    text: "UNSELECTED PRIVATE CONTENT",
    kind: "fact",
    projectId: project.id,
  });
  const deps = {
    db: source,
    tenant,
    catalog: defaultCatalog,
    adapterFor: () => {
      throw new Error("Context preview cannot call a provider");
    },
  };
  const transfer = await captureTransfer(
    deps,
    thread.id,
    "Compare tides",
    { ...EMPTY_SELECTION, memoryIds: [chosen] },
    [models.worker.provider, models.best.provider],
  );
  let inserts = 0,
    drop: "none" | "before" | "after" = "none",
    offline = false;
  const status: HulkStatus = {
    address: "https://hulk.example",
    paired: true,
    mine: { schema: 66, builtFrom: "fixture", builtOn: "2026-11-05", researchProtocol: 1 },
    server: { schema: 66, builtFrom: "fixture", builtOn: "2026-11-05", researchProtocol: 1 },
    mismatch: null,
  };
  const hulk: HulkApi = {
    status: () => Promise.resolve(status),
    pair: () => Promise.reject(new Error("Not used")),
    unpair: () => Promise.reject(new Error("Not used")),
    putFile: () => Promise.reject(new Error("Research never uploads a project export")),
    async invoke<T>(command: string, args: Record<string, unknown> = {}) {
      if (offline) throw new Error("Caller disconnected");
      let result: unknown;
      if (command === "db_execute") {
        const sql = args.sql as string;
        if (sql.includes("INSERT INTO run_requests")) {
          inserts++;
          if (drop === "before") throw new Error("Lost before delivery");
        }
        result = await target.execute(sql, args.params as SqlValue[]);
        if (sql.includes("INSERT INTO run_requests") && drop === "after")
          throw new Error("Lost acknowledgement");
      } else if (command === "db_select")
        result = await target.select(args.sql as string, args.params as SqlValue[]);
      else if (command === "db_batch")
        result = await target.batch(args.statements as SqlStatement[]);
      else throw new Error("Unexpected remote command");
      return result as T;
    },
  };
  return {
    source,
    target,
    project,
    thread,
    deps,
    transfer,
    hulk,
    status,
    input: {
      requestId: uuidv7(),
      task: "Compare tides",
      models,
      capMicroUsd: 25_000_000,
      transfer,
    },
    inserts: () => inserts,
    setDrop: (value: typeof drop) => {
      drop = value;
    },
    disconnect: () => {
      offline = true;
    },
  };
}

test("only explicit selected text transfers; tampering and execution-bearing records fail closed", async () => {
  const { transfer } = await setup();
  const text = JSON.stringify(transfer);
  expect(text).toContain("EXPLICIT SELECTED CONTEXT");
  expect(text).not.toContain("UNSELECTED PRIVATE CONTENT");
  expect(text).not.toContain("/fixture/machine-specific");
  await expect(
    readTransfer({ ...transfer, context: { ...transfer.context, system: "modified" } }),
  ).rejects.toThrow("changed");
  await expect(readTransfer({ ...transfer, protocol: 2 })).rejects.toThrow("protocol");
  await expect(
    readTransfer({
      ...transfer,
      context: {
        ...transfer.context,
        history: [{ role: "user", content: "text", toolResults: [] }],
      },
    }),
  ).rejects.toThrow("selected text only");
});

test.each(["before", "after"] as const)(
  "lost %s-delivery acknowledgement never causes an automatic paid replay",
  async (drop) => {
    const fixture = await setup();
    fixture.setDrop(drop);
    const deps = { db: fixture.source, tenant, hulk: fixture.hulk };
    const link = await startRemoteResearch(deps, fixture.input);
    expect(link.delivery).toBe("unknown");
    await startRemoteResearch(deps, fixture.input);
    expect(fixture.inserts()).toBe(1);
    const observed = await remoteResearchStatus(fixture.hulk, tenant, link, fixture.source);
    expect(observed.statusUnknown).toBe(drop === "before");
    expect(await fixture.target.select("SELECT id FROM run_requests")).toHaveLength(
      drop === "before" ? 0 : 1,
    );
    expect((await remoteResearchLinks(fixture.source, tenant))[0]?.delivery).toBe(
      drop === "before" ? "unknown" : "sent",
    );
    if (drop === "after")
      expect(await fixture.source.select("SELECT input FROM research_transfers")).toEqual([
        { input: null },
      ]);
    expect(await fixture.target.select("SELECT id FROM request_log")).toEqual([]);
  },
);

test("privacy withdrawal after intent commit blocks upload and purges the pending snapshot", async () => {
  const fixture = await setup(),
    execute = fixture.source.execute.bind(fixture.source);
  fixture.source.execute = async (sql, params) => {
    const result = await execute(sql, params);
    if (sql.startsWith("INSERT INTO research_transfers"))
      await setProjectPrivacy(fixture.source, tenant, fixture.project.id, {
        mode: "local_only",
        allowEmbeddings: false,
      });
    return result;
  };
  await expect(
    startRemoteResearch({ db: fixture.source, tenant, hulk: fixture.hulk }, fixture.input),
  ).rejects.toThrow("changed before transfer");
  expect(fixture.inserts()).toBe(0);
  expect(await fixture.source.select("SELECT state,input FROM research_transfers")).toEqual([
    { state: "withdrawn", input: null },
  ]);
  await fixture.source.execute("DELETE FROM threads WHERE id=?", [fixture.thread.id]);
  expect(await remoteResearchLinks(fixture.source, tenant)).toEqual([]);
});

test("a schema-compatible HULK without Research cannot receive context or an intent", async () => {
  const fixture = await setup();
  fixture.status.server = { schema: 66, builtFrom: "old", builtOn: "2026-11-05" };
  await expect(
    startRemoteResearch({ db: fixture.source, tenant, hulk: fixture.hulk }, fixture.input),
  ).rejects.toThrow("Update HULK");
  expect(fixture.inserts()).toBe(0);
  expect(await remoteResearchLinks(fixture.source, tenant)).toEqual([]);
});

test("HULK runs from its typed queue after the caller disconnects, without folders or Code execution", async () => {
  const fixture = await setup(),
    calls: string[] = [];
  const adapterFor = (provider: "openai" | "anthropic" | "local"): ProviderAdapter => ({
    provider,
    listModels: () => Promise.resolve([]),
    async *streamChat(_messages, model, options): AsyncGenerator<StreamEvent> {
      calls.push(model);
      await Promise.resolve();
      let text = '{"claims":[{"id":"C1","supported":true}]}';
      if (options.system?.includes("<research_plan>")) text = '{"queries":["tides"]}';
      else if (options.webSearch) {
        yield {
          type: "search_call",
          call: {
            id: "s",
            action: "search",
            query: "tides",
            sources: [{ url: "https://example.com/tides", title: "Measurements" }],
            error: null,
            truncated: false,
          },
        };
        text = "Tides rise one metre.";
      } else if (options.system?.includes("<research_report>"))
        text = JSON.stringify({
          title: "Measurements",
          claims: [
            {
              text: "Tides rise one metre.",
              evidence: [{ sourceId: "S1", quote: "Tides rise one metre." }],
            },
          ],
          limitations: [],
          disagreements: [],
        });
      yield { type: "text", text };
      yield {
        type: "done",
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          webSearchCalls: options.webSearch ? 1 : 0,
        },
        usageReported: true,
        searchUsageReported: true,
        stopReason: "end_turn",
        providerRequestId: "fixture",
        attempts: 1,
      };
    },
  });
  const link = await startRemoteResearch(
    { db: fixture.source, tenant, hulk: fixture.hulk },
    fixture.input,
  );
  fixture.disconnect();
  const runner = new Runner({
    deps: () =>
      Promise.resolve({
        db: fixture.target,
        tenant,
        catalog: defaultCatalog,
        adapterFor,
        repo: new Proxy({} as RepoApi, {
          get() {
            throw new Error("Research cannot access any repository method");
          },
        }),
        web: {
          fetch: (url) =>
            Promise.resolve({
              url,
              contentType: "text/plain",
              body: "Tides rise one metre.",
              truncated: false,
            }),
        },
      }),
    start: () => Promise.reject(new Error("Must not enter Code")),
    clone: () => Promise.reject(new Error("Must not clone")),
  });
  await runner.tick();
  await runner.idle();
  const request = await getRequest(fixture.target, tenant, link.requestId),
    run = request?.runId ? await getRun(fixture.target, tenant, request.runId) : null;
  expect(run).toMatchObject({ kind: "research", status: "done" });
  expect(calls).toHaveLength(4);
  const receipts = await listRecentRequests(fixture.target, tenant);
  expect(receipts).toHaveLength(4);
  expect(receipts.reduce((sum, row) => sum + row.usage.costMicroUsd, 0)).toBe(run?.spentMicroUsd);
  expect(await fixture.target.select("SELECT repo_root,instructions FROM projects")).toEqual([
    { repo_root: null, instructions: "HULK instructions stay here" },
  ]);
  expect(await fixture.target.select("SELECT id FROM folders")).toEqual([]);
  expect(await fixture.target.select("SELECT id FROM project_mcp_servers")).toEqual([]);
  expect(await fixture.target.select("SELECT id FROM run_changes")).toEqual([]);
});

test("a missing HULK project is not replaced by a partial project record", async () => {
  const fixture = await setup();
  await fixture.target.execute("DELETE FROM projects WHERE id=?", [fixture.project.id]);
  await expect(
    startRemoteResearch({ db: fixture.source, tenant, hulk: fixture.hulk }, fixture.input),
  ).rejects.toThrow("project is not available");
  expect(fixture.inserts()).toBe(0);
  expect(await fixture.target.select("SELECT id FROM projects")).toEqual([]);
  expect(await remoteResearchLinks(fixture.source, tenant)).toEqual([]);
});
