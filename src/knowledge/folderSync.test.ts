// @vitest-environment node
import type { FilesApi } from "@/files/api";
import type { RepoApi } from "@/repo/api";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { listFolderFiles } from "@/storage/folderFiles";
import { grantFolder, linkProjectFolder, unlinkProjectFolder } from "@/storage/folders";
import { listProjectFiles } from "@/storage/projectFiles";
import { createProject } from "@/storage/projects";
import { openTestDb } from "@/storage/testing/nodeDb";
import { listChunks } from "@/storage/vectors";
import { ensureIndexed } from "./retrieve";
import { syncFolderKnowledge } from "./folderSync";

const t = DEFAULT_TENANT;

/** Files on "disk" per folder id: bytes and a modified time. */
type Disk = Map<string, Map<string, { text: string; modified: number }>>;

function fakeRepo(disk: Disk) {
  const reads: string[] = [];
  const repo: RepoApi = {
    pick: () => Promise.resolve(null),
    check: () => Promise.reject(new Error("unused")),
    list: (id) => {
      const files = disk.get(id);
      if (!files) return Promise.reject(new Error("The linked folder is missing"));
      return Promise.resolve(
        [...files].map(([path, f]) => ({
          path,
          dir: false,
          size: f.text.length,
          secret: path.endsWith(".env"),
          modified: f.modified,
        })),
      );
    },
    readBytes: (id, path) => {
      reads.push(`${id}:${path}`);
      const f = disk.get(id)?.get(path);
      return f
        ? Promise.resolve(new TextEncoder().encode(f.text))
        : Promise.reject(new Error("no such file"));
    },
    read: () => Promise.reject(new Error("unused")),
    search: () => Promise.resolve([]),
    write: () => Promise.reject(new Error("unused")),
    remove: () => Promise.reject(new Error("unused")),
    move: () => Promise.reject(new Error("unused")),
  };
  return { repo, reads };
}

function memoryFiles(): FilesApi {
  const store = new Map<string, Uint8Array>();
  let n = 0;
  return {
    put: (bytes) => {
      const sha = `sha${String(++n)}`;
      store.set(sha, bytes);
      return Promise.resolve({ sha256: sha, size: bytes.length });
    },
    get: (sha) => Promise.resolve(store.get(sha) ?? new Uint8Array()),
  };
}

test("FK-07: a project folder's documents become its knowledge and follow changes", async () => {
  const db = openTestDb();
  const p = await createProject(db, t, "Client");
  const folder = await grantFolder(db, t, "/home/me/client");
  await linkProjectFolder(db, t, p.id, folder.id);
  const docs = new Map([
    ["brief.md", { text: "# Brief\nThe launch is in March.", modified: 1 }],
    ["notes/call.txt", { text: "Budget is 40k.", modified: 1 }],
    ["app.ts", { text: "export {}", modified: 1 }], // code isn't knowledge
    [".env", { text: "TOKEN=x", modified: 1 }], // secret-looking: skipped
  ]);
  const disk: Disk = new Map([[folder.id, docs]]);
  const { repo, reads } = fakeRepo(disk);
  const deps = { db, tenant: t, repo, files: memoryFiles() };

  expect(await syncFolderKnowledge(deps, p.id, true)).toMatchObject({ added: 2, removed: 0 });
  const names = async () => (await listProjectFiles(db, t, p.id)).map((f) => f.name).sort();
  expect(await names()).toEqual(["client/brief.md", "client/notes/call.txt"]);
  expect(reads).toEqual([`${folder.id}:brief.md`, `${folder.id}:notes/call.txt`]);

  // A quick pass reads nothing that hasn't changed size or time.
  reads.length = 0;
  expect(await syncFolderKnowledge(deps, p.id, false)).toMatchObject({ added: 0, updated: 0 });
  expect(reads).toEqual([]);

  // Index the brief, then change it: the old text's record and chunks go, the new one comes in.
  const brief = (await listProjectFiles(db, t, p.id)).find((f) => f.name.endsWith("brief.md"));
  if (!brief) throw new Error("no brief");
  const noEmbedding = {
    priceVersion: "test",
    adapterFor: () => {
      throw new Error("no embeddings in this test");
    },
  };
  await ensureIndexed({ ...deps, ...noEmbedding }, null, brief);
  expect((await listChunks(db, t, "file", brief.id)).length).toBeGreaterThan(0);
  docs.set("brief.md", { text: "# Brief\nThe launch moved to May.", modified: 2 });
  expect(await syncFolderKnowledge(deps, p.id, false)).toMatchObject({ updated: 1 });
  expect(await listChunks(db, t, "file", brief.id)).toEqual([]);
  expect(await names()).toEqual(["client/brief.md", "client/notes/call.txt"]);
  expect((await listProjectFiles(db, t, p.id)).some((f) => f.id === brief.id)).toBe(false);

  // Touched but identical: re-read, hash matches, nothing new.
  docs.set("notes/call.txt", { text: "Budget is 40k.", modified: 3 });
  expect(await syncFolderKnowledge(deps, p.id, false)).toMatchObject({ added: 0, updated: 0 });

  // Deleted on disk: gone from knowledge.
  docs.delete("notes/call.txt");
  expect(await syncFolderKnowledge(deps, p.id, false)).toMatchObject({ removed: 1 });
  expect(await names()).toEqual(["client/brief.md"]);
  expect((await listFolderFiles(db, t, folder.id)).map((f) => f.path)).toEqual(["brief.md"]);
});

test("FK-07: a missing folder keeps its knowledge; an unlinked one leaves the project", async () => {
  const db = openTestDb();
  const p = await createProject(db, t, "P");
  const folder = await grantFolder(db, t, "/media/usb/docs");
  await linkProjectFolder(db, t, p.id, folder.id);
  const disk: Disk = new Map([[folder.id, new Map([["a.md", { text: "Alpha", modified: 1 }]])]]);
  const deps = { db, tenant: t, repo: fakeRepo(disk).repo, files: memoryFiles() };
  await syncFolderKnowledge(deps, p.id, true);

  disk.delete(folder.id); // unplugged
  expect(await syncFolderKnowledge(deps, p.id, true)).toMatchObject({ removed: 0 });
  expect((await listProjectFiles(db, t, p.id)).map((f) => f.name)).toEqual(["docs/a.md"]);

  await unlinkProjectFolder(db, t, p.id, folder.id);
  await syncFolderKnowledge(deps, p.id, true);
  expect(await listProjectFiles(db, t, p.id)).toEqual([]);
});
