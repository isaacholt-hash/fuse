// git and gh in the linked repository (CA-05), through Rust (src-tauri/src/git.rs): run with an
// argument list (no shell), an allowlist of subcommands, prompts off.
import { invoke } from "@tauri-apps/api/core";

export interface GitResult {
  output: string;
  exitCode: number | null;
}

export interface GitApi {
  run(folderId: string, program: "git" | "gh", args: string[]): Promise<GitResult>;
}

export const tauriGit: GitApi = {
  run: (folderId, program, args) => invoke<GitResult>("repo_git", { folderId, program, args }),
};
