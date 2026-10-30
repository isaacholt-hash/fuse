// @vitest-environment node
// M7 step 12 (LL-08): the local path's security cases, end to end through housekeeping.
// (The worker process itself — crashes, the OOM killer, time limits, bad output, an empty
// environment — is tested in src-tauri/src/local.rs; model files in model_files.rs.)
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { findModel, type CatalogModel } from "@/catalog/catalog";
import { housekeepingCall, housekeepingModel } from "@/chat/housekeeping";
import { autoTitle } from "@/chat/title";
import { ceilings } from "@/context/ceilings";
import { ProviderError } from "@/providers/errors";
import { scriptedLocal } from "@/providers/local/scripted";
import type { ProviderAdapter } from "@/providers/types";
import { checkClassification } from "@/routing/classifyFallback";
import { classify } from "@/routing/classify";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { addMessage, finishMessage } from "@/storage/messages";
import { createProject, setProjectPrivacy } from "@/storage/projects";
import { listRecentRequests } from "@/storage/requestLog";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread, getThread } from "@/storage/threads";
import { lexicalNearest, replaceChunks } from "@/storage/vectors";
import { localCatalogModel, localModels } from "./models";

const t = DEFAULT_TENANT;
const profile = localModels.profiles.at(-1);
if (!profile) throw new Error("no local profile");
const local = localCatalogModel(profile, localModels.verifiedOn);
const haiku = findModel(defaultCatalog, "anthropic", "claude-haiku-5-5") as CatalogModel;

/** A cloud that's unreachable: every call fails as if offline, and is counted. */
function offlineCloud() {
  let calls = 0;
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    // eslint-disable-next-line require-yield -- fails before any event, like a dropped network
    async *streamChat() {
      calls++;
      await Promise.resolve();
      throw new ProviderError("network", "offline");
    },
  };
  return { adapter, calls: () => calls };
}

async function chatWithAnswer(projectId: string | null = null) {
  const db = openTestDb();
  const thread = await createThread(db, t, "New chat", projectId);
  const q = await addMessage(db, t, {
    threadId: thread.id,
    parentId: null,
    role: "user",
    content: "How do I descale a kettle?",
  });
  const a = await addMessage(db, t, {
    threadId: thread.id,
    parentId: q,
    role: "assistant",
    content: "",
    status: "streaming",
  });
  await finishMessage(db, t, a, {
    content: "Boil water with citric acid, then rinse.",
    status: "complete",
  });
  return { db, thread };
}

test("offline: housekeeping runs on the local model with no network, and nothing reaches the cloud", async () => {
  const { db, thread } = await chatWithAnswer();
  const l = scriptedLocal(["Descaling a kettle"]);
  const cloud = offlineCloud();
  const deps = {
    db,
    tenant: t,
    adapterFor: (p: string) => (p === "local" ? l.adapter : cloud.adapter),
    local,
  };
  const r = await autoTitle(deps, defaultCatalog, thread.id, haiku);
  expect(r.title).toBe("Descaling a kettle");
  expect(cloud.calls()).toBe(0);
  expect((await listRecentRequests(db, t)).map((x) => x.provider)).toEqual(["local"]);
});

test("Local only with no cloud key: the local model does housekeeping alone; it never falls back", async () => {
  const db0 = openTestDb();
  const project = await createProject(db0, t, "Health");
  await setProjectPrivacy(db0, t, project.id, { mode: "local_only", allowEmbeddings: false });
  const thread = await createThread(db0, t, "New chat", project.id);
  const helper = housekeepingModel(defaultPolicy, defaultCatalog, "title", [], undefined, local);
  expect(helper?.provider).toBe("local");
  const l = scriptedLocal([
    new ProviderError("unavailable", "The local model stopped unexpectedly"),
  ]);
  const cloud = offlineCloud();
  const r = await housekeepingCall(
    { db: db0, tenant: t, adapterFor: (p) => (p === "local" ? l.adapter : cloud.adapter), local },
    defaultCatalog,
    {
      purpose: "title",
      threadId: thread.id,
      model: haiku,
      system: "s",
      input: "private",
      maxOutputTokens: 20,
    },
  );
  expect(r.ok).toBe(false);
  expect(cloud.calls()).toBe(0);
  expect((await getThread(db0, t, thread.id))?.title).toBe("New chat");
});

test("malformed local output never becomes a decision: a junk second opinion keeps the heuristics", async () => {
  const db = openTestDb();
  const l = scriptedLocal(["Sure! I think it's probably coding-ish?"]);
  const cloud = offlineCloud();
  const deps = {
    db,
    tenant: t,
    adapterFor: (p: string) => (p === "local" ? l.adapter : cloud.adapter),
    local,
  };
  const question = "refactor this whole module, maybe?";
  const heuristic = { ...classify({ text: question }), unsure: true };
  const r = await checkClassification(deps, defaultCatalog, haiku, heuristic, question, null);
  expect(r.intent).toBe(heuristic.intent);
  expect(r.complexity).toBe(heuristic.complexity);
  // The junk reply was the local model's; the cloud fallback is tried only when it *fails*.
  expect(l.calls).toHaveLength(1);
});

test("too much input: it's cut to the local ceiling before it's sent, with a marker", async () => {
  const db = openTestDb();
  const l = scriptedLocal(["Long chat"]);
  const deps = { db, tenant: t, adapterFor: () => l.adapter, local };
  const huge = "word ".repeat(50_000);
  const r = await housekeepingCall(deps, defaultCatalog, {
    purpose: "summary",
    threadId: null,
    model: haiku,
    system: "Summarize.",
    input: huge,
    maxOutputTokens: 200,
  });
  expect(r.ok).toBe(true);
  const sent = l.calls[0]?.messages[0]?.content ?? "";
  expect(sent.length).toBeLessThan(ceilings.localInputTokens * 4 + 200);
  expect(sent).toMatch(/more characters left out/);
});

test("cross-project isolation: one project's file chunks never answer another's search", async () => {
  const db = openTestDb();
  await replaceChunks(db, t, "file", "file-in-A", [
    {
      ordinal: 0,
      text: "Project A secret: the launch code word is heron.",
      tokens: 12,
      page: null,
      lineStart: 1,
      lineEnd: 1,
    },
  ]);
  await replaceChunks(db, t, "file", "file-in-B", [
    {
      ordinal: 0,
      text: "Project B notes about birds.",
      tokens: 6,
      page: null,
      lineStart: 1,
      lineEnd: 1,
    },
  ]);
  expect(
    await lexicalNearest(db, t, "heron launch code", { kind: "file", ids: ["file-in-B"] }),
  ).toEqual([]);
  expect(
    (await lexicalNearest(db, t, "heron", { kind: "file", ids: ["file-in-A"] }))[0]?.chunk.sourceId,
  ).toBe("file-in-A");
});
