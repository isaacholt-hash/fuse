// @vitest-environment node
import { addVersion, listArtifacts, listVersions, saveArtifacts } from "./artifacts";
import { DEFAULT_TENANT } from "./defaults";
import { addMessage } from "./messages";
import { openTestDb } from "./testing/nodeDb";
import { createThread, purgeThread } from "./threads";

const t = DEFAULT_TENANT;
const block = (content: string, title = "Plan") => ({
  key: "plan",
  title,
  type: "markdown" as const,
  language: "",
  content,
  complete: true,
});

test("the same key makes a new version only when the content changed; purge removes them", async () => {
  const db = openTestDb();
  const thread = await createThread(db, t);
  const m1 = await addMessage(db, t, {
    threadId: thread.id,
    parentId: null,
    role: "assistant",
    content: "x",
  });
  await saveArtifacts(db, t, thread.id, m1, [block("# v1")]);
  await saveArtifacts(db, t, thread.id, m1, [block("# v1")]);
  await saveArtifacts(db, t, thread.id, m1, [block("# v2", "Plan, revised")]);
  const [a] = await listArtifacts(db, t, thread.id);
  expect(a).toMatchObject({ key: "plan", title: "Plan, revised", version: 2, content: "# v2" });
  expect(await addVersion(db, t, a?.id ?? "", "# mine", "user")).toBe(3);
  expect((await listVersions(db, t, a?.id ?? "")).map((v) => [v.version, v.source])).toEqual([
    [1, "model"],
    [2, "model"],
    [3, "user"],
  ]);
  await purgeThread(db, t, thread.id);
  expect(await listArtifacts(db, t, thread.id)).toEqual([]);
});

test("simultaneous version counters keep UUID identity and deterministic display numbering", async () => {
  const db = openTestDb();
  const thread = await createThread(db, t);
  const message = await addMessage(db, t, {
    threadId: thread.id,
    parentId: null,
    role: "assistant",
    content: "Synthetic",
  });
  await saveArtifacts(db, t, thread.id, message, [block("first")]);
  const artifact = (await listArtifacts(db, t, thread.id))[0];
  if (!artifact) throw new Error("Fixture artifact is missing");
  await db.execute(
    "INSERT INTO artifact_versions(id,workspace_id,user_id,artifact_id,version,content,source,created_at,updated_at) VALUES (?,?,?,?,1,?,'user',1,1)",
    ["concurrent-version", t.workspaceId, t.userId, artifact.id, "simultaneous"],
  );
  const versions = await listVersions(db, t, artifact.id);
  expect(versions.map((v) => v.version)).toEqual([1, 2]);
  expect(new Set(versions.map((v) => v.id)).size).toBe(2);
  const firstId = versions[0]?.id;
  if (!firstId) throw new Error("Fixture version is missing");
  await db.execute(
    "INSERT INTO sync_aliases(workspace_id,user_id,table_name,original_id,canonical_id,created_at,updated_at) VALUES (?,?,'artifacts','prior-id',?,1,1)",
    [t.workspaceId, t.userId, artifact.id],
  );
  expect((await listVersions(db, t, "prior-id")).map((v) => v.id)).toContain(firstId);
  expect(await addVersion(db, t, "prior-id", "third", "user")).toBe(3);
  expect(await listArtifacts(db, t, thread.id)).toHaveLength(1);
  expect((await listArtifacts(db, t, thread.id))[0]).toMatchObject({
    version: 3,
    content: "third",
  });
});
