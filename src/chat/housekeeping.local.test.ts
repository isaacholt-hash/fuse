// @vitest-environment node
// M7 step 8 (LL-04): housekeeping goes to the local model first, falls back once to the cloud.
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { findModel, type CatalogModel } from "@/catalog/catalog";
import { localCatalogModel, localModels } from "@/local/models";
import { ProviderError } from "@/providers/errors";
import { scriptedLocal } from "@/providers/local/scripted";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject, setProjectPrivacy, type PrivacyMode } from "@/storage/projects";
import { listRecentRequests } from "@/storage/requestLog";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread } from "@/storage/threads";
import { cloudCallsAvoidedSince } from "@/storage/usageReport";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { housekeepingCall, housekeepingModel } from "./housekeeping";

const t = DEFAULT_TENANT;
const profile = localModels.profiles[1];
if (!profile) throw new Error("missing profile");
const local = localCatalogModel(profile, localModels.verifiedOn);
const cloud = findModel(defaultCatalog, "anthropic", "claude-haiku-5-5") as CatalogModel;

async function setup(
  localReplies: (string | ProviderError)[],
  cloudReplies: (string | ProviderError)[],
  mode: PrivacyMode = "normal",
  withLocal = true,
) {
  const db = openTestDb();
  const project = await createProject(db, t, "P");
  await setProjectPrivacy(db, t, project.id, { mode, allowEmbeddings: true });
  const thread = await createThread(db, t, "x", project.id);
  const l = scriptedLocal(localReplies, new ProviderError("unavailable", "no more"));
  const c = scriptedLocal(cloudReplies, new ProviderError("server", "no more"));
  const deps = {
    db,
    tenant: t,
    adapterFor: (p: string) => (p === "local" ? l.adapter : c.adapter),
    local: withLocal ? local : null,
  };
  const call = () =>
    housekeepingCall(deps, defaultCatalog, {
      purpose: "title",
      threadId: thread.id,
      model: cloud,
      system: "Title it.",
      input: "q",
      maxOutputTokens: 20,
    });
  const rows = async () =>
    (await listRecentRequests(db, t)).map((r) => `${r.provider}:${r.errorCode ?? "ok"}`).reverse();
  return { db, call, rows, l, c };
}

test("the local model answers: no cloud call, logged at $0, counted as avoided", async () => {
  const s = await setup(["Local title"], []);
  expect(await s.call()).toMatchObject({ ok: true, text: "Local title", costMicroUsd: 0 });
  expect(s.c.calls).toHaveLength(0);
  expect(await s.rows()).toEqual(["local:ok"]);
  expect(await cloudCallsAvoidedSince(s.db, t, 0)).toBe(1);
});

test("the local model fails: one fallback to the cloud model, both attempts logged", async () => {
  const s = await setup(
    [new ProviderError("stream", "The local model gave an empty answer.")],
    ["Cloud title"],
  );
  expect(await s.call()).toMatchObject({ ok: true, text: "Cloud title" });
  expect(await s.rows()).toEqual(["local:stream", "anthropic:ok"]);
  // A failed local try isn't a cloud call avoided.
  expect(await cloudCallsAvoidedSince(s.db, t, 0)).toBe(0);
});

test("both fail: two attempts in all, no loop", async () => {
  const s = await setup(
    [new ProviderError("unavailable", "not installed")],
    [new ProviderError("server", "down")],
  );
  expect((await s.call()).ok).toBe(false);
  expect(s.l.calls).toHaveLength(1);
  expect(s.c.calls).toHaveLength(1);
});

test("Local only: housekeeping runs locally; if it fails, nothing goes to the cloud", async () => {
  const ok = await setup(["Kept here"], [], "local_only");
  expect(await ok.call()).toMatchObject({ ok: true, text: "Kept here" });
  const failed = await setup(
    [new ProviderError("unavailable", "crashed")],
    ["never"],
    "local_only",
  );
  expect(await failed.call()).toMatchObject({ ok: false, error: /Local only/ });
  expect(failed.c.calls).toHaveLength(0);
});

test("Cloud only, or the switch off: the local model isn't used", async () => {
  const cloudOnly = await setup(["never"], ["Cloud title"], "cloud_only");
  expect(await cloudOnly.call()).toMatchObject({ ok: true, text: "Cloud title" });
  expect(cloudOnly.l.calls).toHaveLength(0);
  const off = await setup(["never"], ["Cloud title"], "normal", false);
  expect(await off.call()).toMatchObject({ ok: true, text: "Cloud title" });
  expect(off.l.calls).toHaveLength(0);
});

test("with no cloud key, the local model does housekeeping alone", () => {
  expect(housekeepingModel(defaultPolicy, defaultCatalog, "title", [], undefined, local)).toBe(
    local,
  );
  expect(housekeepingModel(defaultPolicy, defaultCatalog, "title", [], undefined, null)).toBeNull();
  expect(
    housekeepingModel(defaultPolicy, defaultCatalog, "title", ["anthropic"], undefined, local)
      ?.provider,
  ).toBe("anthropic");
});
