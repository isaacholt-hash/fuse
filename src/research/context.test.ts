// @vitest-environment node
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { openTestDb } from "@/storage/testing/nodeDb";
import { createThread, setThreadProject, setThreadInstructions } from "@/storage/threads";
import {
  createProject,
  setProjectRepo,
  updateProject,
  setProjectPrivacy,
} from "@/storage/projects";
import { setGlobalInstructions } from "@/storage/instructions";
import { addMemory } from "@/storage/memories";
import { addMessage } from "@/storage/messages";
import { saveArtifacts, listArtifacts, addVersion } from "@/storage/artifacts";
import { setSetting } from "@/storage/settings";
import { selectedContext } from "./context";
import { EMPTY_SELECTION } from "./types";

async function setup() {
  const db = openTestDb(),
    project = await createProject(db, tenant, "Selected project"),
    thread = await createThread(db, tenant);
  await setThreadProject(db, tenant, thread.id, project.id);
  await setProjectRepo(db, tenant, project.id, { root: "/fixture/repo", readSecrets: false });
  await updateProject(db, tenant, project.id, {
    name: project.name,
    defaultModel: null,
    instructions: "UNSELECTED PROJECT",
  });
  await setThreadInstructions(db, tenant, thread.id, "UNSELECTED CHAT");
  await setGlobalInstructions(db, tenant, { aboutYou: "UNSELECTED GLOBAL", howToAnswer: "" });
  const picked = await addMemory(db, tenant, {
    text: "SELECTED MEMORY " + "long context ".repeat(100),
    kind: "fact",
    projectId: project.id,
  });
  await addMemory(db, tenant, {
    text: "UNSELECTED MEMORY",
    kind: "decision",
    projectId: project.id,
  });
  const privateId = await addMemory(db, tenant, {
    text: "PRIVATE MEMORY",
    kind: "fact",
    maySend: false,
  });
  const message = await addMessage(db, tenant, {
    threadId: thread.id,
    role: "user",
    parentId: null,
    content: "SELECTED MESSAGE",
  });
  await saveArtifacts(db, tenant, thread.id, message, [
    {
      key: "picked",
      title: "Picked",
      type: "markdown",
      language: "",
      content: "SELECTED ARTIFACT",
      complete: true,
    },
    {
      key: "other",
      title: "Other",
      type: "markdown",
      language: "",
      content: "UNSELECTED ARTIFACT",
      complete: true,
    },
  ]);
  const artifacts = await listArtifacts(db, tenant, thread.id);
  const artifact = artifacts.find((a) => a.key === "picked"),
    other = artifacts.find((a) => a.key === "other");
  if (!artifact || !other) throw new Error("Missing fixture artifacts");
  await addVersion(db, tenant, other.id, "UNSELECTED EDITED ARTIFACT", "user");
  let folderReads = 0;
  const deps = {
    db,
    tenant,
    catalog: defaultCatalog,
    adapterFor: () => {
      throw new Error("Context assembly must not call a provider");
    },
    repo: {
      read: () => {
        folderReads++;
        throw new Error("Must not load folders");
      },
    },
  };
  const initialGrants = await db.select("SELECT * FROM folders");
  return {
    db,
    deps,
    initialGrants,
    project,
    thread,
    picked,
    privateId,
    message,
    artifact,
    folderReads: () => folderReads,
  };
}

test("research uses only selected records, including selected model artifacts, and never reads folders", async () => {
  const { db, deps, thread, picked, message, artifact, folderReads, initialGrants } = await setup();
  await setSetting(db, tenant, "memory.budget_tokens", "128");
  const context = await selectedContext(
    deps,
    thread.id,
    "Selected scope",
    { memoryIds: [picked], messageIds: [message], artifactIds: [artifact.id], instructions: [] },
    "openai",
    "desktop",
  );
  const sent = JSON.stringify(context);
  for (const included of ["SELECTED MEMORY", "SELECTED MESSAGE", "SELECTED ARTIFACT"])
    expect(sent).toContain(included);
  for (const excluded of ["UNSELECTED", "PRIVATE MEMORY", "/fixture/repo"])
    expect(sent).not.toContain(excluded);
  expect(folderReads()).toBe(0);
  expect(await db.select("SELECT * FROM folders")).toEqual(initialGrants);
});

test("privacy exclusions and selected-record changes are checked before dispatch", async () => {
  const { db, deps, thread, picked, privateId, artifact, project } = await setup();
  await expect(
    selectedContext(
      deps,
      thread.id,
      "Scope",
      { ...EMPTY_SELECTION, memoryIds: [privateId] },
      "openai",
      "desktop",
    ),
  ).rejects.toThrow("private");
  const selection = { ...EMPTY_SELECTION, memoryIds: [picked], artifactIds: [artifact.id] };
  const before = await selectedContext(deps, thread.id, "Scope", selection, "openai", "desktop");
  await addVersion(db, tenant, artifact.id, "UPDATED SELECTED ARTIFACT", "user");
  const after = await selectedContext(deps, thread.id, "Scope", selection, "openai", "desktop");
  expect(after.fingerprint).not.toBe(before.fingerprint);
  await db.execute("UPDATE threads SET local_only=1 WHERE id=?", [thread.id]);
  await expect(
    selectedContext(deps, thread.id, "Scope", EMPTY_SELECTION, "openai", "hulk"),
  ).rejects.toThrow("device");
  await db.execute("UPDATE threads SET local_only=0,incognito=1 WHERE id=?", [thread.id]);
  await expect(
    selectedContext(deps, thread.id, "Scope", EMPTY_SELECTION, "openai", "desktop"),
  ).rejects.toThrow("incognito");
  await db.execute("UPDATE threads SET incognito=0 WHERE id=?", [thread.id]);
  await setProjectPrivacy(db, tenant, project.id, { mode: "local_only", allowEmbeddings: false });
  await expect(
    selectedContext(deps, thread.id, "Scope", EMPTY_SELECTION, "openai", "desktop"),
  ).rejects.toThrow("Local only");
});
