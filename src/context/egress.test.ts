// @vitest-environment node
import { parseCatalog, type CatalogModel } from "@/catalog/catalog";
import { housekeepingCall } from "@/chat/housekeeping";
import { sendMessage } from "@/chat/sendMessage";
import type { ProviderAdapter, StreamEvent } from "@/providers/types";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { setEgressRule } from "@/storage/egress";
import { listRecentRequests } from "@/storage/requestLog";
import { listMessages } from "@/storage/messages";
import { createProject, setProjectPrivacy } from "@/storage/projects";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread, setThreadProject } from "@/storage/threads";
import { allowedEmbedding, egressRefusal, policyFor, projectPolicy } from "./egress";

const t = DEFAULT_TENANT;
const project = { id: "p1", name: "Health", privacyMode: "normal" as const, allowEmbeddings: true };

test("a project's own rule wins over the global one; no rule means allowed (SE-13)", () => {
  expect(policyFor(null, []).blocked).toEqual([]);
  const rules = [
    { projectId: null, provider: "openai" as const, allow: false },
    { projectId: "p1", provider: "openai" as const, allow: true },
    { projectId: "p1", provider: "anthropic" as const, allow: false },
  ];
  expect(policyFor(null, rules).blocked).toEqual(["openai"]);
  expect(policyFor(project, rules).blocked).toEqual(["anthropic"]);
  expect(policyFor({ ...project, id: "p2" }, rules).blocked).toEqual(["openai"]);
});

test("refusals say why, per purpose", () => {
  const blocked = policyFor(project, [{ projectId: "p1", provider: "anthropic", allow: false }]);
  expect(egressRefusal(blocked, "anthropic", "chat")).toMatch(/“Health” blocks Anthropic/);
  expect(egressRefusal(blocked, "openai", "chat")).toBeNull();
  const local = policyFor({ ...project, privacyMode: "local_only" }, []);
  expect(egressRefusal(local, "openai", "housekeeping")).toMatch(/Local only/);
  const noSearch = policyFor({ ...project, allowEmbeddings: false }, []);
  expect(egressRefusal(noSearch, "openai", "chat")).toBeNull();
  expect(egressRefusal(noSearch, "openai", "embeddings")).toMatch(/embedded/);
  const model = {
    provider: "openai" as const,
    id: "emb",
    dimensions: 3,
    maxInputTokens: 8000,
    inputPrice: 0.02,
    verifiedOn: "2026-10-26",
    sourceUrl: "https://example.com",
  };
  expect(allowedEmbedding(noSearch, model)).toBeNull();
  expect(allowedEmbedding(blocked, model)).toBe(model);
});

const catalog = parseCatalog({
  price_version: "2026-10-26",
  models: [
    {
      provider: "anthropic",
      id: "test-claude",
      display_name: "Test Claude",
      context_window: 200000,
      max_output: 1000,
      price: { input: 2, output: 10 },
      capabilities: [],
      verified_on: "2026-10-26",
      source_url: "https://example.com",
    },
  ],
});
const claude = catalog.models[0] as CatalogModel;

async function* answer(): AsyncGenerator<StreamEvent> {
  await Promise.resolve();
  yield { type: "text", text: "Hi" };
}

test("a blocked provider never gets the chat or the housekeeping call, and the answer says why", async () => {
  const db = openTestDb();
  let calls = 0;
  const adapter: ProviderAdapter = {
    provider: "anthropic",
    listModels: () => Promise.resolve([]),
    streamChat() {
      calls += 1;
      return answer();
    },
  };
  const deps = { db, tenant: t, catalog, adapterFor: () => adapter };
  const p = await createProject(db, t, "Health");
  const thread = await createThread(db, t);
  await setThreadProject(db, t, thread.id, p.id);
  await setEgressRule(db, t, p.id, "anthropic", false);

  const r = await sendMessage(deps, { threadId: thread.id, text: "My results?", model: claude });
  expect(r.status).toBe("error");
  expect(r.error).toMatch(/“Health” blocks Anthropic/);
  const answers = (await listMessages(db, t, thread.id)).filter((m) => m.role === "assistant");
  expect(answers[0]?.errorMessage).toMatch(/blocks Anthropic/);
  const [log] = await listRecentRequests(db, t, 1);
  expect(log).toMatchObject({ errorCode: "egress" });

  const hk = await housekeepingCall(deps, catalog, {
    purpose: "title",
    threadId: thread.id,
    model: claude,
    system: "x",
    input: "y",
    maxOutputTokens: 10,
  });
  expect(hk).toEqual({ ok: false, error: expect.stringMatching(/blocks Anthropic/) as string });

  await setEgressRule(db, t, p.id, "anthropic", null);
  await setProjectPrivacy(db, t, p.id, { mode: "local_only", allowEmbeddings: true });
  expect((await projectPolicy(db, t, p.id)).mode).toBe("local_only");
  const local = await sendMessage(deps, { threadId: thread.id, text: "Again", model: claude });
  expect(local.error).toMatch(/Local only/);
  expect(calls).toBe(0);
});
