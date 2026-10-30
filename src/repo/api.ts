// Folders FUSE may work in (CA-01, WF-02), through Rust: every path is checked there against the
// granted folder's root from the database, so nothing here can reach outside it (src-tauri/src/repo.rs).
import { invoke } from "@tauri-apps/api/core";

export interface RepoInfo {
  root: string;
  name: string;
  isGit: boolean;
}

export interface RepoEntry {
  path: string;
  dir: boolean;
  size: number;
  secret: boolean;
}

export interface RepoFileText {
  path: string;
  content: string;
  offset: number;
  totalBytes: number;
  truncated: boolean;
}

export interface RepoHit {
  path: string;
  line: number;
  text: string;
}

/** A file written, deleted or moved; `before` is what it held (null: it didn't exist). */
export interface RepoChange {
  path: string;
  before: string | null;
}

export interface RepoApi {
  /** The folder picker; null when cancelled. */
  pick(): Promise<RepoInfo | null>;
  check(path: string): Promise<RepoInfo>;
  list(folderId: string, path: string, recursive: boolean): Promise<RepoEntry[]>;
  read(folderId: string, path: string, offset: number): Promise<RepoFileText>;
  /** WF-03: a whole file's bytes (documents, images), up to 25 MB. */
  readBytes?(folderId: string, path: string): Promise<Uint8Array>;
  /** WF-04: writes a binary file whole; returns its path. */
  writeBytes?(folderId: string, path: string, bytes: Uint8Array): Promise<string>;
  /** WF-04: removes a binary file (undoing one FUSE made). */
  removeBytes?(folderId: string, path: string): Promise<void>;
  search(folderId: string, path: string, query: string, ignoreCase: boolean): Promise<RepoHit[]>;
  write(folderId: string, path: string, content: string): Promise<RepoChange>;
  remove(folderId: string, path: string): Promise<RepoChange>;
  move(folderId: string, from: string, to: string): Promise<RepoChange>;
}

export const tauriRepo: RepoApi = {
  pick: () => invoke<RepoInfo | null>("repo_pick"),
  check: (path) => invoke<RepoInfo>("repo_check", { path }),
  list: (folderId, path, recursive) =>
    invoke<RepoEntry[]>("repo_list", { folderId, path, recursive }),
  read: (folderId, path, offset) => invoke<RepoFileText>("repo_read", { folderId, path, offset }),
  readBytes: async (folderId, path) =>
    new Uint8Array(await invoke<ArrayBuffer>("repo_read_bytes", { folderId, path })),
  writeBytes: (folderId, path, bytes) =>
    invoke<string>("repo_write_bytes", bytes, {
      headers: { "x-folder-id": encodeURIComponent(folderId), "x-path": encodeURIComponent(path) },
    }),
  removeBytes: (folderId, path) => invoke("repo_remove_bytes", { folderId, path }),
  search: (folderId, path, query, ignoreCase) =>
    invoke<RepoHit[]>("repo_search", { folderId, path, query, ignoreCase }),
  write: (folderId, path, content) => invoke<RepoChange>("repo_write", { folderId, path, content }),
  remove: (folderId, path) => invoke<RepoChange>("repo_delete", { folderId, path }),
  move: (folderId, from, to) => invoke<RepoChange>("repo_move", { folderId, from, to }),
};
