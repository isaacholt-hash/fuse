// @vitest-environment node
import type { RepoApi, RepoEntry } from "@/repo/api";
import type { Folder } from "@/storage/folders";
import { labelFolders, resolvePath, scopedRepo } from "./folders";

const folder = (id: string, path: string): Folder => ({
  id,
  path,
  readSecrets: false,
  createdAt: 1,
});

/** A repository per folder id, in memory. */
function fakeRepo(files: Record<string, Record<string, string>>) {
  const calls: string[] = [];
  const at = (id: string) => (files[id] ??= {});
  const repo: RepoApi = {
    pick: () => Promise.resolve(null),
    check: () => Promise.reject(new Error("unused")),
    list: (id, path) => {
      calls.push(`list ${id} ${path}`);
      return Promise.resolve(
        Object.keys(at(id)).map((p): RepoEntry => ({
          path: p,
          dir: false,
          size: 1,
          secret: false,
        })),
      );
    },
    read: (id, path) => {
      calls.push(`read ${id} ${path}`);
      const content = at(id)[path];
      return content === undefined
        ? Promise.reject(new Error(`${path}: no such file`))
        : Promise.resolve({
            path,
            content,
            offset: 0,
            totalBytes: content.length,
            truncated: false,
          });
    },
    search: (id) =>
      Promise.resolve(Object.keys(at(id)).map((p) => ({ path: p, line: 1, text: "x" }))),
    write: (id, path, content) => {
      calls.push(`write ${id} ${path}`);
      const before = at(id)[path] ?? null;
      at(id)[path] = content;
      return Promise.resolve({ path, before });
    },
    remove: (id, path) => Promise.resolve({ path: `${id}:${path}`, before: null }),
    move: (_id, _from, to) => Promise.resolve({ path: to, before: null }),
  };
  return { repo, calls };
}

test("labels are each folder's name, made unique", () => {
  expect(
    labelFolders([
      folder("a", "/home/me/notes"),
      folder("b", "/work/notes"),
      folder("c", "C:\\Docs\\"),
    ]).map((f) => f.label),
  ).toEqual(["notes", "notes-2", "Docs"]);
});

test("one folder: paths as before; several: the first segment names the folder", () => {
  const one = labelFolders([folder("a", "/x/app")]);
  expect(resolvePath(one, "src/main.ts")).toMatchObject({
    folder: { folderId: "a" },
    rel: "src/main.ts",
  });
  const two = labelFolders([folder("a", "/x/app"), folder("b", "/y/docs")]);
  expect(resolvePath(two, "docs/plan.md")).toMatchObject({
    folder: { folderId: "b" },
    rel: "plan.md",
  });
  expect(resolvePath(two, "./APP/src")).toMatchObject({ folder: { folderId: "a" }, rel: "src" });
  expect(() => resolvePath(two, "src/main.ts")).toThrow(
    /start it with one of this chat's folders: app\/, docs\//,
  );
  expect(() => resolvePath([], "x")).toThrow(/no folder/);
});

test("the scoped repository routes each call to its folder and prefixes what comes back", async () => {
  const { repo, calls } = fakeRepo({ a: { "README.md": "app" }, b: { "plan.md": "docs" } });
  const scoped = scopedRepo(repo, labelFolders([folder("a", "/x/app"), folder("b", "/y/docs")]));
  expect((await scoped.list("", "", false)).map((e) => e.path)).toEqual(["app", "docs"]);
  expect((await scoped.list("", "", true)).map((e) => e.path)).toEqual([
    "app",
    "docs",
    "app/README.md",
    "docs/plan.md",
  ]);
  expect((await scoped.read("", "docs/plan.md", 0)).path).toBe("docs/plan.md");
  expect(await scoped.write("", "app/new.txt", "hi")).toEqual({
    path: "app/new.txt",
    before: null,
  });
  expect(calls).toContain("write a new.txt");
  expect((await scoped.search("", "", "x", false)).map((h) => h.path)).toEqual([
    "app/README.md",
    "app/new.txt",
    "docs/plan.md",
  ]);
  await expect(scoped.move("", "app/README.md", "docs/README.md")).rejects.toThrow(
    /between folders/,
  );
  // One folder: nothing is prefixed, exactly as in M6.
  const single = scopedRepo(repo, labelFolders([folder("a", "/x/app")]));
  expect((await single.read("", "README.md", 0)).path).toBe("README.md");
});
