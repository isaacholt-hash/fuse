// The linked repository (CA-01), through Rust: every path is checked there against the root
// stored for the project, so nothing here can reach outside it (src-tauri/src/repo.rs).
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
  list(projectId: string, path: string, recursive: boolean): Promise<RepoEntry[]>;
  read(projectId: string, path: string, offset: number): Promise<RepoFileText>;
  search(projectId: string, path: string, query: string, ignoreCase: boolean): Promise<RepoHit[]>;
  write(projectId: string, path: string, content: string): Promise<RepoChange>;
  remove(projectId: string, path: string): Promise<RepoChange>;
  move(projectId: string, from: string, to: string): Promise<RepoChange>;
}

export const tauriRepo: RepoApi = {
  pick: () => invoke<RepoInfo | null>("repo_pick"),
  check: (path) => invoke<RepoInfo>("repo_check", { path }),
  list: (projectId, path, recursive) =>
    invoke<RepoEntry[]>("repo_list", { projectId, path, recursive }),
  read: (projectId, path, offset) => invoke<RepoFileText>("repo_read", { projectId, path, offset }),
  search: (projectId, path, query, ignoreCase) =>
    invoke<RepoHit[]>("repo_search", { projectId, path, query, ignoreCase }),
  write: (projectId, path, content) =>
    invoke<RepoChange>("repo_write", { projectId, path, content }),
  remove: (projectId, path) => invoke<RepoChange>("repo_delete", { projectId, path }),
  move: (projectId, from, to) => invoke<RepoChange>("repo_move", { projectId, from, to }),
};
