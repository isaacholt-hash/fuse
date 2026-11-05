// @vitest-environment node
import type { Catalog, EmbeddingModel } from "@/catalog/catalog";
import type { ProviderAdapter, ToolCall } from "@/providers/types";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createProject, setProjectPrivacy } from "@/storage/projects";
import { createThread, setThreadMemory } from "@/storage/threads";
import {
  addMemory,
  editMemory,
  listMemories,
  listPendingProposals,
  approveProposal,
} from "@/storage/memories";
import { listVersions } from "@/storage/artifacts";
import { setEgressRule } from "@/storage/egress";
import { clearVectors } from "@/data/storage";
import { createRun } from "@/storage/runs";
import { listRecentRequests } from "@/storage/requestLog";
import type { ContextOwner } from "./access";
import { contextTool } from "./tools";
import { findArtifacts } from "./artifactSearch";

const embedding: EmbeddingModel = {
  provider: "openai",
  id: "recorded-meaning",
  dimensions: 2,
  maxInputTokens: 1000,
  inputPrice: 1,
  verifiedOn: "2026-11-05",
  sourceUrl: "https://example.invalid/fixtures",
};
const catalog: Catalog = {
  priceVersion: "recorded",
  models: [],
  toolPrices: [],
  embeddingModels: [embedding],
};
async function setup() {
  const db = openTestDb(),
    project = await createProject(db, tenant, "Writing");
  const thread = await createThread(db, tenant, "Drafts", project.id);
  const embed = vi.fn<NonNullable<ProviderAdapter["embed"]>>((texts) =>
    Promise.resolve({
      vectors: texts.map(() => Float32Array.of(1, 0)),
      tokens: 10,
      usageReported: true,
      attempts: 1,
      providerRequestId: "recorded",
    }),
  );
  const adapter: ProviderAdapter = {
    provider: "openai",
    listModels: () => Promise.resolve([]),
    streamChat() {
      throw new Error("Fixture: no model call");
    },
    embed,
  };
  const deps = { db, tenant, catalog, adapterFor: () => adapter };
  const owner: ContextOwner = {
    threadId: thread.id,
    projectId: project.id,
    runId: null,
    messageId: null,
    provider: "openai",
    model: "recorded",
    callKey: "fixture",
  };
  let seq = 0;
  const call = async (name: string, input: Record<string, unknown>, key?: string) => {
    const result = await contextTool(
      deps,
      { ...owner, callKey: key ?? `fixture:${String(seq++)}` },
      { id: "call", name, input },
      embedding,
    );
    return result;
  };
  const create = async (
    key = "brief",
    content = "A guide to electric cars",
    inThread = thread.id,
  ) => {
    // The store's message FK is nullable; tool calls keep provenance when a message exists.
    const r = await contextTool(
      deps,
      { ...owner, threadId: inThread, callKey: `create:${key}:${inThread}` },
      {
        id: "create",
        name: "create_artifact",
        input: { key, title: key, type: "markdown", content },
      },
    );
    expect(r.isError, r.output).toBe(false);
    return JSON.parse(r.output) as { id: string; versionId: string };
  };
  return { db, deps, project, thread, owner, call, create, embed };
}

test("memory additions remain conversation-scoped pending review with model provenance", async () => {
  const { db, thread, call } = await setup();
  const input = { operation: "add", kind: "preference", text: "Prefers concise drafts" };
  const first = await call("propose_memory", input, "same-turn"),
    again = await call("propose_memory", input, "same-turn");
  expect(first.isError, first.output).toBe(false);
  expect(again.isError, again.output).toBe(false);
  const [p] = await listPendingProposals(db, tenant);
  expect(p).toMatchObject({
    threadId: thread.id,
    sourceThreadId: thread.id,
    extractionModel: "openai/recorded",
    origin: "chat",
  });
  expect(await listMemories(db, tenant)).toHaveLength(0);
  await Promise.all([
    approveProposal(db, tenant, p?.id ?? ""),
    approveProposal(db, tenant, p?.id ?? "").catch((e: unknown) => {
      expect(String(e)).toContain("changed");
    }),
  ]);
  const memories = await listMemories(db, tenant);
  expect(memories).toHaveLength(1);
  expect(memories[0]).toMatchObject({
    scope: "conversation",
    threadId: thread.id,
    authority: "extracted",
    extractionModel: "openai/recorded",
  });
  expect(await db.select("SELECT tool_name,outcome FROM context_tool_audit")).toEqual([
    { tool_name: "propose_memory", outcome: "proposed" },
  ]);
});

test("stale memory suggestions never overwrite an owner edit or lose privacy/authority", async () => {
  const { db, thread, project, call } = await setup();
  const id = await addMemory(db, tenant, {
    text: "Draft the first chapter",
    kind: "task",
    projectId: project.id,
    threadId: thread.id,
    sensitivity: "sensitive",
    expiresAt: Date.now() + 86400000,
  });
  let target = (await listMemories(db, tenant))[0];
  expect(
    (
      await call("propose_memory", {
        operation: "update",
        id,
        expected_revision: target?.revision,
        text: "Draft two chapters",
      })
    ).isError,
  ).toBe(false);
  const [p] = await listPendingProposals(db, tenant);
  await editMemory(db, tenant, id, {
    text: "Keep the owner version",
    kind: "task",
    projectId: project.id,
    threadId: thread.id,
    maySend: false,
    sensitivity: "sensitive",
  });
  await expect(approveProposal(db, tenant, p?.id ?? "")).rejects.toThrow("changed");
  expect((await listMemories(db, tenant))[0]).toMatchObject({
    text: "Keep the owner version",
    maySend: false,
    authority: "you",
  });
  expect(await listPendingProposals(db, tenant)).toHaveLength(1);
  await db.execute("UPDATE memories SET may_send=1 WHERE id=?", [id]);
  target = (await listMemories(db, tenant))[0];
  expect(
    (
      await call("propose_memory", {
        operation: "update",
        id,
        expected_revision: target?.revision,
        text: "Approved change",
      })
    ).isError,
  ).toBe(false);
  const next = (await listPendingProposals(db, tenant)).at(-1);
  await approveProposal(db, tenant, next?.id ?? "");
  expect((await listMemories(db, tenant))[0]).toMatchObject({
    text: "Approved change",
    authority: "you",
    sensitivity: "sensitive",
    scope: "conversation",
    threadId: thread.id,
  });
});

test("memory decisions, global mutations, disabled memory and out-of-scope records are refused", async () => {
  const { db, thread, project, call } = await setup();
  const decision = await addMemory(db, tenant, {
    text: "Use Markdown",
    kind: "decision",
    projectId: project.id,
  });
  const global = await addMemory(db, tenant, { text: "Global preference", kind: "preference" });
  const elsewhere = await createProject(db, tenant, "Other");
  await addMemory(db, tenant, {
    text: "Private other topic",
    kind: "fact",
    projectId: elsewhere.id,
  });
  await addMemory(db, tenant, {
    text: "Never send this fact",
    kind: "fact",
    projectId: project.id,
    maySend: false,
  });
  for (const id of [decision, global])
    expect(
      (await call("propose_memory", { operation: "delete", id, expected_revision: 1 })).isError,
    ).toBe(true);
  expect(
    (await call("propose_memory", { operation: "add", kind: "decision", text: "Forbidden" }))
      .isError,
  ).toBe(true);
  const read = await call("read_memory", {});
  expect(read.output).toContain("Use Markdown");
  expect(read.output).not.toContain("Private other topic");
  expect(read.output).not.toContain("Never send this fact");
  await setThreadMemory(db, tenant, thread.id, false);
  expect((await call("read_memory", {})).isError).toBe(true);
  expect(
    (await call("propose_memory", { operation: "add", kind: "fact", text: "No" })).isError,
  ).toBe(true);
});

test("memory sources with incognito or blocked-provider policy cannot leak through global scope", async () => {
  const { db, call } = await setup();
  const other = await createProject(db, tenant, "Sensitive source"),
    source = await createThread(db, tenant, "Origin", other.id);
  await addMemory(db, tenant, {
    text: "Confidential origin",
    kind: "fact",
    sourceThreadId: source.id,
  });
  await setEgressRule(db, tenant, other.id, "openai", false);
  expect((await call("read_memory", {})).output).not.toContain("Confidential origin");
  await setEgressRule(db, tenant, other.id, "openai", true);
  await db.execute("UPDATE threads SET incognito=1 WHERE id=?", [source.id]);
  expect((await call("read_memory", {})).output).not.toContain("Confidential origin");
});

test("artifact creation and updates are idempotent, UUID pinned and retain both versions", async () => {
  const { db, call, create } = await setup(),
    a = await create();
  const input = {
    id: a.id,
    expected_version_id: a.versionId,
    content: "A revised guide to electric cars",
  };
  const [one, two] = await Promise.all([
    call("update_artifact", input, "same-update"),
    call("update_artifact", input, "same-update"),
  ]);
  expect(one.isError, one.output).toBe(false);
  expect(two.isError, two.output).toBe(false);
  const versions = await listVersions(db, tenant, a.id);
  expect(versions).toHaveLength(2);
  expect(versions[0]?.id).toBe(a.versionId);
  const stale = await call("update_artifact", { ...input, content: "Must not overwrite" });
  expect(stale.isError).toBe(true);
  expect((await call("read_artifact", { id: a.id, version_id: a.versionId })).isError).toBe(true);
  expect((await call("read_artifact", { id: a.id, version_id: versions[1]?.id })).output).toContain(
    "revised guide",
  );
  expect(
    (
      await call("create_artifact", {
        key: "brief",
        title: "Collision",
        type: "markdown",
        content: "No",
      })
    ).isError,
  ).toBe(true);
  expect(await listVersions(db, tenant, a.id)).toHaveLength(2);
});

test("concurrent competing edits create one winner; deleted or private sources cannot be resurrected", async () => {
  const { db, thread, call, create } = await setup(),
    a = await create();
  const input = { id: a.id, expected_version_id: a.versionId };
  const result = await Promise.all([
    call("update_artifact", { ...input, content: "First change" }),
    call("update_artifact", { ...input, content: "Second change" }),
  ]);
  expect(result.filter((r) => !r.isError)).toHaveLength(1);
  expect(await listVersions(db, tenant, a.id)).toHaveLength(2);
  await db.execute("UPDATE artifacts SET deleted_at=1 WHERE id=?", [a.id]);
  expect((await call("update_artifact", { ...input, content: "Resurrect" })).isError).toBe(true);
  expect((await call("search_artifacts", { query: "change" })).output).not.toContain(a.id);
  await db.execute("UPDATE threads SET local_only=1 WHERE id=?", [thread.id]);
  expect(
    (await call("create_artifact", { key: "new", title: "New", type: "markdown", content: "No" }))
      .isError,
  ).toBe(true);
});

test("artifact reads are bounded and source references include version, conversation and provenance", async () => {
  const { thread, call, create } = await setup(),
    a = await create("long", "A".repeat(13000));
  const read = await call("read_artifact", { id: a.id, version_id: a.versionId });
  expect(read.isError, read.output).toBe(false);
  const value = JSON.parse(read.output) as { content: string; nextOffset: number };
  expect(value.content).toHaveLength(12000);
  expect(value.nextOffset).toBe(12000);
  expect(JSON.parse(read.output)).toMatchObject({
    threadId: thread.id,
    threadTitle: "Drafts",
    source: "model",
    versionId: a.versionId,
    totalCharacters: 13000,
  });
  expect(
    (await call("read_artifact", { id: a.id, version_id: a.versionId, offset: 12000 })).output,
  ).toContain('"nextOffset":null');
});

test("meaning finds synonyms, caches exact versions, records one charge and clears with the index", async () => {
  const { db, deps, owner, create, embed } = await setup();
  const a = await create("vehicles", "A guide to electric cars");
  let result = await findArtifacts(deps, owner, "automobiles", { meaning: true, embedding });
  expect(result).toMatchObject({
    mode: "meaning",
    billing: "reported",
    results: [{ id: a.id, reason: "meaning" }],
  });
  expect(embed.mock.calls[0]?.[0]).toHaveLength(2);
  result = await findArtifacts(deps, owner, "automobiles", { meaning: true, embedding });
  expect(embed).toHaveBeenCalledTimes(1);
  expect(result.mode).toBe("keyword");
  await findArtifacts(deps, { ...owner, callKey: "second-search" }, "automobiles", {
    meaning: true,
    embedding,
  });
  expect(embed.mock.calls[1]?.[0]).toHaveLength(1);
  expect(await listRecentRequests(db, tenant)).toHaveLength(2);
  expect(await clearVectors(db, tenant)).toBe(1);
  expect(await db.select("SELECT * FROM artifact_vectors")).toHaveLength(0);
});

test("keyword fallback excludes other projects, private sources and blocked embedding transfers", async () => {
  const { db, deps, owner, thread, project, create, embed } = await setup();
  const a = await create("vehicles", "A guide to electric cars");
  const other = await createProject(db, tenant, "Other"),
    otherThread = await createThread(db, tenant, "Other", other.id);
  await contextTool(
    deps,
    { ...owner, projectId: other.id, threadId: otherThread.id, callKey: "other" },
    {
      id: "x",
      name: "create_artifact",
      input: {
        key: "hidden",
        title: "Hidden",
        type: "markdown",
        content: "Electric private material",
      },
    },
  );
  await setProjectPrivacy(db, tenant, project.id, { mode: "normal", allowEmbeddings: false });
  const result = await findArtifacts(deps, owner, "electric", { meaning: true, embedding });
  expect(result.mode).toBe("keyword");
  expect(result.results.map((x) => x.id)).toEqual([a.id]);
  expect(embed).not.toHaveBeenCalled();
  await db.execute("UPDATE threads SET incognito=1 WHERE id=?", [thread.id]);
  await expect(
    findArtifacts(deps, owner, "electric", { meaning: true, embedding }),
  ).rejects.toThrow();
  expect(embed).not.toHaveBeenCalled();
});

test("an interrupted semantic call falls back once without retry and retains unresolved exposure", async () => {
  const { db, deps, owner, create, embed } = await setup();
  await create();
  embed.mockRejectedValue(new Error("Interrupted transport"));
  const result = await findArtifacts(deps, owner, "electric", { meaning: true, embedding });
  expect(result).toMatchObject({ mode: "keyword", billing: "unresolved" });
  expect(result.results).toHaveLength(1);
  await findArtifacts(deps, owner, "electric", { meaning: true, embedding });
  expect(embed).toHaveBeenCalledTimes(1);
  expect((await listRecentRequests(db, tenant))[0]).toMatchObject({ billingState: "unknown" });
});

test("embedding results are discarded after a source becomes private, with incurred cost retained", async () => {
  const { db, deps, owner, thread, create, embed } = await setup();
  await create();
  embed.mockImplementation(async (texts) => {
    await db.execute("UPDATE threads SET local_only=1 WHERE id=?", [thread.id]);
    return {
      vectors: texts.map(() => Float32Array.of(1, 0)),
      tokens: 10,
      usageReported: true,
      attempts: 1,
      providerRequestId: "recorded",
    };
  });
  await expect(
    findArtifacts(deps, owner, "electric", { meaning: true, embedding }),
  ).rejects.toThrow();
  expect(await db.select("SELECT * FROM artifact_vectors")).toHaveLength(0);
  expect((await listRecentRequests(db, tenant))[0]?.usage.costMicroUsd).toBe(10);
});

test("Plan/review and stopped runs cannot create context, and a shared cap blocks semantic dispatch", async () => {
  const { db, deps, owner, project, thread, embed, create } = await setup();
  await create();
  const run = await createRun(db, tenant, {
    projectId: project.id,
    threadId: thread.id,
    messageId: null,
    provider: "openai",
    model: "recorded",
    task: "Read",
    capMicroUsd: 1,
  });
  const c: ToolCall = {
    id: "x",
    name: "create_artifact",
    input: { key: "denied", title: "Denied", type: "markdown", content: "No" },
  };
  expect((await contextTool(deps, { ...owner, runId: run.id }, c)).isError).toBe(true);
  const r = await findArtifacts(deps, { ...owner, runId: run.id }, "electric", {
    meaning: true,
    embedding,
  });
  expect(r.mode).toBe("keyword");
  expect(embed).not.toHaveBeenCalled();
  await db.execute("UPDATE runs SET status='stopped' WHERE id=?", [run.id]);
  expect((await contextTool(deps, { ...owner, runId: run.id }, c)).isError).toBe(true);
});

test("cancellation during scope checks saves no proposal or artifact", async () => {
  const { db, deps, owner } = await setup();
  for (const name of ["create_artifact", "propose_memory"]) {
    const controller = new AbortController();
    const interrupted = {
      ...deps,
      db: {
        ...db,
        select: async <Row>(sql: string, params?: import("@/storage/sql").SqlValue[]) => {
          const rows = await db.select<Row>(sql, params);
          if (sql.includes("FROM context_tool_audit")) controller.abort();
          return rows;
        },
      },
    };
    const input =
      name === "create_artifact"
        ? { key: "cancelled", title: "Cancelled", type: "markdown", content: "No change" }
        : { operation: "add", kind: "fact", text: "No change" };
    const result = await contextTool(
      interrupted,
      { ...owner, callKey: `cancelled:${name}` },
      { id: "cancelled", name, input },
      null,
      controller.signal,
    );
    expect(result.isError, result.output).toBe(true);
  }
  expect(await db.select("SELECT * FROM artifacts")).toHaveLength(0);
  expect(await db.select("SELECT * FROM memory_proposals")).toHaveLength(0);
});

test("revoking embedding consent during the response purges derived vectors and preserves the charge", async () => {
  const { db, deps, owner, project, create, embed } = await setup();
  await create();
  embed.mockImplementation(async (texts) => {
    await setProjectPrivacy(db, tenant, project.id, { mode: "normal", allowEmbeddings: false });
    return {
      vectors: texts.map(() => Float32Array.of(1, 0)),
      tokens: 10,
      usageReported: true,
      attempts: 1,
      providerRequestId: "recorded",
    };
  });
  const result = await findArtifacts(deps, owner, "electric", { meaning: true, embedding });
  expect(result.mode).toBe("keyword");
  expect(result.results).toHaveLength(1);
  expect(await db.select("SELECT * FROM artifact_vectors")).toHaveLength(0);
  expect((await listRecentRequests(db, tenant))[0]?.usage.costMicroUsd).toBe(10);
});

test("a pinned memory deletion changes nothing until approved and is acknowledged atomically", async () => {
  const { db, project, thread, call } = await setup();
  const id = await addMemory(db, tenant, {
    text: "Retire this obsolete fact",
    kind: "fact",
    projectId: project.id,
    threadId: thread.id,
  });
  expect(
    (await call("propose_memory", { operation: "delete", id, expected_revision: 1 })).isError,
  ).toBe(false);
  expect(await listMemories(db, tenant)).toHaveLength(1);
  const [p] = await listPendingProposals(db, tenant);
  await approveProposal(db, tenant, p?.id ?? "");
  expect(await listMemories(db, tenant)).toHaveLength(0);
  expect(await listPendingProposals(db, tenant)).toHaveLength(0);
  expect(await db.select("SELECT status FROM memory_proposals")).toEqual([{ status: "approved" }]);
  await approveProposal(db, tenant, p?.id ?? "");
  expect(await db.select("SELECT COUNT(*) AS n FROM memories")).toEqual([{ n: 1 }]);
});
