/**
 * The folders a run works in (M8, WF-02), behind the same RepoApi, ExecApi and GitApi the run
 * already uses. With one folder, paths are as they were (M6). With several, a path starts with
 * the folder's label ("notes/2026/plan.md"), the root lists the folders, and search covers all
 * of them. The Rust side still checks every path against the folder's root from the database.
 * Commands and git run in the run's first folder.
 */
import type { RepoApi, RepoEntry, RepoHit } from "@/repo/api";
import type { ExecApi } from "@/repo/exec";
import type { GitApi } from "@/repo/git";
import { loadRepoInstructions, type RepoInstruction } from "@/repo/instructions";
import type { Tenant } from "@/storage/defaults";
import { folderName, listProjectFolders, listThreadFolders, type Folder } from "@/storage/folders";
import type { SqlDb } from "@/storage/sql";
import type { RunFolder } from "@/storage/runs";

/** Labels for a run's folders: each folder's name, made unique ("notes", "notes-2"). */
export function labelFolders(folders: readonly Folder[]): RunFolder[] {
  const used = new Set<string>();
  const out: RunFolder[] = [];
  for (const f of folders) {
    if (out.some((o) => o.folderId === f.id)) continue;
    const base = folderName(f.path).replace(/[\\/]/g, "-") || "folder";
    let label = base;
    for (let n = 2; used.has(label.toLowerCase()); n++) label = `${base}-${String(n)}`;
    used.add(label.toLowerCase());
    out.push({ folderId: f.id, label });
  }
  return out;
}

const trimSlashes = (p: string) =>
  p
    .replace(/^[./\\]+(?=.)/, "")
    .replace(/^\.$/, "")
    .replace(/[\\/]+$/, "");

/** Which folder a path is in, and the path inside it. Throws with a plain message if unclear. */
export function resolvePath(
  folders: readonly RunFolder[],
  path: string,
): { folder: RunFolder; rel: string } {
  const first = folders[0];
  if (!first) throw new Error("This chat has no folder to work in.");
  if (folders.length === 1) return { folder: first, rel: path };
  const clean = trimSlashes(path.replace(/\\/g, "/"));
  const [head = "", ...rest] = clean.split("/");
  const folder = folders.find((f) => f.label.toLowerCase() === head.toLowerCase());
  if (!folder) {
    throw new Error(
      `${path || "That path"}: start it with one of this chat's folders: ${folders.map((f) => `${f.label}/`).join(", ")}.`,
    );
  }
  return { folder, rel: rest.join("/") };
}

const isRoot = (path: string) => trimSlashes(path.replace(/\\/g, "/")) === "";

/** The repository API over a run's folders. The first argument of each call is ignored. */
export function scopedRepo(base: RepoApi, folders: readonly RunFolder[]): RepoApi {
  const one = folders.length === 1;
  const prefix = (label: string, p: string) => (one ? p : p ? `${label}/${p}` : label);
  const entries = (label: string, list: RepoEntry[]) =>
    list.map((e) => ({ ...e, path: prefix(label, e.path) }));
  const hits = (label: string, list: RepoHit[]) =>
    list.map((h) => ({ ...h, path: prefix(label, h.path) }));
  return {
    pick: () => base.pick(),
    check: (p) => base.check(p),
    list: async (_id, path, recursive) => {
      if (!one && isRoot(path)) {
        const top: RepoEntry[] = folders.map((f) => ({
          path: f.label,
          dir: true,
          size: 0,
          secret: false,
        }));
        if (!recursive) return top;
        const all = await Promise.all(
          folders.map(async (f) => entries(f.label, await base.list(f.folderId, "", true))),
        );
        return [...top, ...all.flat()];
      }
      const { folder, rel } = resolvePath(folders, path);
      return entries(folder.label, await base.list(folder.folderId, rel, recursive));
    },
    read: async (_id, path, offset) => {
      const { folder, rel } = resolvePath(folders, path);
      const f = await base.read(folder.folderId, rel, offset);
      return { ...f, path: prefix(folder.label, f.path) };
    },
    search: async (_id, path, query, ignoreCase) => {
      if (!one && isRoot(path)) {
        const all = await Promise.all(
          folders.map(async (f) =>
            hits(f.label, await base.search(f.folderId, "", query, ignoreCase)),
          ),
        );
        return all.flat().slice(0, 200);
      }
      const { folder, rel } = resolvePath(folders, path);
      return hits(folder.label, await base.search(folder.folderId, rel, query, ignoreCase));
    },
    write: async (_id, path, content) => {
      const { folder, rel } = resolvePath(folders, path);
      const c = await base.write(folder.folderId, rel, content);
      return { ...c, path: prefix(folder.label, c.path) };
    },
    remove: async (_id, path) => {
      const { folder, rel } = resolvePath(folders, path);
      const c = await base.remove(folder.folderId, rel);
      return { ...c, path: prefix(folder.label, c.path) };
    },
    move: async (_id, from, to) => {
      const a = resolvePath(folders, from);
      const b = resolvePath(folders, to);
      if (a.folder.folderId !== b.folder.folderId) {
        throw new Error(
          "Moving between folders isn't supported: write a copy, then delete the original.",
        );
      }
      const c = await base.move(a.folder.folderId, a.rel, b.rel);
      return { ...c, path: prefix(b.folder.label, c.path) };
    },
  };
}

/** Commands run in the run's first folder. */
export function scopedExec(base: ExecApi, folders: readonly RunFolder[]): ExecApi {
  return {
    run: (_id, command, opts) => {
      const first = folders[0];
      if (!first) return Promise.reject(new Error("This chat has no folder to run commands in."));
      return base.run(first.folderId, command, opts);
    },
  };
}

/** git and gh run in the run's first folder. */
export function scopedGit(base: GitApi, folders: readonly RunFolder[]): GitApi {
  return {
    run: (_id, program, args) => {
      const first = folders[0];
      if (!first) return Promise.reject(new Error("This chat has no folder for git."));
      return base.run(first.folderId, program, args);
    },
  };
}

/** CA-06: CLAUDE.md and AGENTS.md at the root of each folder (prefixed by label when several). */
export async function instructionsIn(
  repo: RepoApi,
  folders: readonly Folder[],
  dirs: readonly string[] = [],
): Promise<RepoInstruction[]> {
  if (folders.length === 0) return [];
  const labelled = labelFolders(folders);
  const roots = labelled.length > 1 ? labelled.map((f) => f.label) : [""];
  return loadRepoInstructions(scopedRepo(repo, labelled), "", [...roots, ...dirs]);
}

/** WF-02: the chat's own folders first, then its project's; each once. */
export async function foldersFor(
  deps: { db: SqlDb; tenant: Tenant },
  where: { projectId: string | null; threadId: string | null },
): Promise<Folder[]> {
  const own = where.threadId ? await listThreadFolders(deps.db, deps.tenant, where.threadId) : [];
  const shared = where.projectId
    ? await listProjectFolders(deps.db, deps.tenant, where.projectId)
    : [];
  return [...own, ...shared.filter((f) => !own.some((o) => o.id === f.id))];
}
