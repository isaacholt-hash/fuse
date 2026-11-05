// git and gh in the linked repository (CA-05), through Rust (src-tauri/src/git.rs): run with an
// argument list (no shell), an allowlist of subcommands, prompts off.
import { invoke } from "@/platform/core";
import type { ReviewSnapshot } from "@/review/types";

export interface GitResult {
  output: string;
  exitCode: number | null;
}

export interface GitApi {
  snapshot?(
    folderId: string,
    selection: { kind: "changes" | "branch"; baseRef?: string; headRef?: string },
  ): Promise<ReviewSnapshot>;
  run(folderId: string, program: "git" | "gh", args: string[]): Promise<GitResult>;
}

export const tauriGit: GitApi = {
  snapshot: (folderId, selection) => invoke("repo_review_snapshot", { folderId, selection }),
  run: (folderId, program, args) => invoke<GitResult>("repo_git", { folderId, program, args }),
};
