// @vitest-environment node
import { DEFAULT_TENANT } from "./defaults";
import {
  folderName,
  grantFolder,
  linkProjectFolder,
  linkThreadFolder,
  listProjectFolders,
  listThreadFolders,
  unlinkProjectFolder,
  unlinkThreadFolder,
} from "./folders";
import { createProject, getProject, setProjectRepo } from "./projects";
import { openTestDb } from "./testing/nodeDb";
import { createThread } from "./threads";

const t = DEFAULT_TENANT;

test("a folder is granted once by path; projects and chats link it", async () => {
  const db = openTestDb();
  const a = await grantFolder(db, t, "/home/me/docs");
  const again = await grantFolder(db, t, "/home/me/docs", true);
  expect(again.id).toBe(a.id);
  expect(again.readSecrets).toBe(true);
  const p = await createProject(db, t, "P");
  const b = await grantFolder(db, t, "/home/me/code");
  await linkProjectFolder(db, t, p.id, a.id);
  await linkProjectFolder(db, t, p.id, b.id);
  await linkProjectFolder(db, t, p.id, b.id); // twice is once
  expect((await listProjectFolders(db, t, p.id)).map((f) => f.path)).toEqual([
    "/home/me/docs",
    "/home/me/code",
  ]);
  await unlinkProjectFolder(db, t, p.id, a.id);
  expect((await listProjectFolders(db, t, p.id)).map((f) => f.path)).toEqual(["/home/me/code"]);
  const thread = await createThread(db, t);
  await linkThreadFolder(db, t, thread.id, a.id);
  expect((await listThreadFolders(db, t, thread.id)).map((f) => f.id)).toEqual([a.id]);
  await unlinkThreadFolder(db, t, thread.id, a.id);
  expect(await listThreadFolders(db, t, thread.id)).toEqual([]);
  expect(folderName("/home/me/code")).toBe("code");
  expect(folderName("C:\\Users\\me\\Notes\\")).toBe("Notes");
});

test("a project's linked repository is its first folder (M6 setter, now folder-backed)", async () => {
  const db = openTestDb();
  const p = await createProject(db, t, "P");
  await setProjectRepo(db, t, p.id, { root: "/code/app", readSecrets: true });
  expect(await getProject(db, t, p.id)).toMatchObject({
    repoRoot: "/code/app",
    repoReadSecrets: true,
  });
  await setProjectRepo(db, t, p.id, { root: "/code/other", readSecrets: false });
  expect((await listProjectFolders(db, t, p.id)).map((f) => f.path)).toEqual(["/code/other"]);
  await setProjectRepo(db, t, p.id, { root: null, readSecrets: false });
  expect(await getProject(db, t, p.id)).toMatchObject({ repoRoot: null, repoReadSecrets: false });
});
