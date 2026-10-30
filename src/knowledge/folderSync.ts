/**
 * Knowledge that follows a folder (M8 step 11, FK-07): the documents in a project's folders are
 * the project's knowledge, kept in step with what's on disk. Each document's text becomes a file
 * record linked to the project (so it's indexed and searched like an uploaded one); a changed
 * document gets a new record, a removed one loses its record. Ignored files never reach here (the
 * folder listing skips them) and secret-looking files are always skipped.
 *
 * A full pass (at start) hashes every document; a quick pass (while FUSE runs) reads only those
 * whose size or modified time changed.
 */
import type { FilesApi } from "@/files/api";
import { prepareDocument } from "@/files/documents";
import { xlsxText } from "@/documents/read";
import type { RepoApi, RepoEntry } from "@/repo/api";
import type { Tenant } from "@/storage/defaults";
import { addFile } from "@/storage/files";
import {
  folderFileOwners,
  listFolderFiles,
  removeFolderFile,
  retireFolderFileRecord,
  saveFolderFile,
  touchFolderFile,
} from "@/storage/folderFiles";
import { folderName, listProjectFolders } from "@/storage/folders";
import { addProjectFile, listProjectFiles, removeProjectFile } from "@/storage/projectFiles";
import type { SqlDb } from "@/storage/sql";

/** Documents, not code: code is read by the agent's tools, not searched as knowledge. */
const DOCUMENT_EXTENSIONS = new Set(
  "pdf docx xlsx xlsm md markdown txt csv tsv rst org tex html htm rtf".split(" "),
);
/** Larger files are left out (a PDF that size is rarely worth searching whole). */
export const MAX_FOLDER_DOC_BYTES = 25 * 1024 * 1024;
/** Per folder, so one huge folder can't take over the index. */
export const MAX_FOLDER_DOCS = 500;

export interface FolderSyncDeps {
  db: SqlDb;
  tenant: Tenant;
  repo: RepoApi;
  files: FilesApi;
}

export interface FolderSyncResult {
  added: number;
  updated: number;
  removed: number;
  /** Documents that couldn't be read, as "folder/path: why". */
  problems: string[];
}

const extension = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";

export function isFolderDocument(e: RepoEntry): boolean {
  return (
    !e.dir &&
    !e.secret &&
    e.size <= MAX_FOLDER_DOC_BYTES &&
    DOCUMENT_EXTENSIONS.has(extension(e.path))
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A document's searchable text, as knowledge stores it. */
async function documentText(path: string, bytes: Uint8Array) {
  const name = path.split("/").at(-1) ?? path;
  const ext = extension(path);
  if (ext === "xlsx" || ext === "xlsm") {
    const text = xlsxText(bytes);
    return { bytes: new TextEncoder().encode(text), tokens: Math.ceil(text.length / 4) };
  }
  const doc = await prepareDocument(new File([new Uint8Array(bytes)], name), { searchPdf: true });
  return { bytes: doc.bytes, tokens: doc.tokens };
}

/**
 * Brings one project's folder knowledge up to date: every linked folder's documents in, the
 * removed ones out, and documents of folders no longer linked unlinked from the project.
 */
export async function syncFolderKnowledge(
  deps: FolderSyncDeps,
  projectId: string,
  full: boolean,
): Promise<FolderSyncResult> {
  const { db, tenant, repo } = deps;
  const result: FolderSyncResult = { added: 0, updated: 0, removed: 0, problems: [] };
  const read = repo.readBytes?.bind(repo);
  if (!read) return result;
  const folders = await listProjectFolders(db, tenant, projectId);
  const wanted = new Set<string>();
  for (const folder of folders) {
    const label = folderName(folder.path);
    let entries: RepoEntry[];
    try {
      entries = (await repo.list(folder.id, "", true)).filter(isFolderDocument);
    } catch {
      // A folder that's missing (an unplugged drive) keeps what was indexed from it.
      for (const f of await listFolderFiles(db, tenant, folder.id)) wanted.add(f.fileId);
      continue;
    }
    entries = entries.slice(0, MAX_FOLDER_DOCS);
    const known = new Map((await listFolderFiles(db, tenant, folder.id)).map((f) => [f.path, f]));
    const seen = new Set<string>();
    for (const e of entries) {
      seen.add(e.path);
      const before = known.get(e.path);
      const modified = e.modified ?? null;
      if (before && !full && before.sizeBytes === e.size && before.modifiedAt === modified) {
        wanted.add(before.fileId);
        continue;
      }
      try {
        const bytes = await read(folder.id, e.path);
        const sha = await sha256(bytes);
        if (before?.sha256 === sha) {
          if (before.sizeBytes !== e.size || before.modifiedAt !== modified) {
            await touchFolderFile(db, tenant, before.id, e.size, modified);
          }
          wanted.add(before.fileId);
          continue;
        }
        const text = await documentText(e.path, bytes);
        const stored = await deps.files.put(text.bytes);
        const file = await addFile(db, tenant, {
          name: `${label}/${e.path}`,
          mime: "text/plain",
          sizeBytes: stored.size,
          sha256: stored.sha256,
          tokenEstimate: text.tokens,
        });
        await saveFolderFile(db, tenant, {
          folderId: folder.id,
          path: e.path,
          fileId: file.id,
          sha256: sha,
          sizeBytes: e.size,
          modifiedAt: modified,
        });
        if (before) await retireFolderFileRecord(db, tenant, before.fileId);
        wanted.add(file.id);
        if (before) result.updated += 1;
        else result.added += 1;
      } catch (err) {
        if (before) wanted.add(before.fileId);
        result.problems.push(
          `${label}/${e.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    for (const [path, f] of known) {
      if (seen.has(path)) continue;
      await removeFolderFile(db, tenant, f);
      result.removed += 1;
    }
  }
  // Link what's wanted; unlink folder documents that aren't (their folder left the project).
  const owners = await folderFileOwners(db, tenant);
  const linked = new Set((await listProjectFiles(db, tenant, projectId)).map((f) => f.id));
  for (const id of linked) {
    if (owners.has(id) && !wanted.has(id)) await removeProjectFile(db, tenant, projectId, id);
  }
  for (const id of wanted) {
    if (!linked.has(id)) await addProjectFile(db, tenant, projectId, id);
  }
  return result;
}
