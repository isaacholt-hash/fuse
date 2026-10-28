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
