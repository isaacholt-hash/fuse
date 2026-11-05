// git and gh in the linked repository (CA-05), through Rust (src-tauri/src/git.rs): run with an
// argument list (no shell), an allowlist of subcommands, prompts off.
import { invoke } from "@/platform/core";
import type { ReviewSnapshot } from "@/review/types";
import type { ParallelApi, ChildBase, ChildPreparation, PreparedChild } from "@/parallel/types";

export interface GitResult {
  output: string;
  exitCode: number | null;
}

export interface GitApi extends Partial<ParallelApi> {
  childBase?(parentId: string): Promise<ChildBase>;
  prepareChildren?(request: ChildPreparation): Promise<PreparedChild[]>;
  snapshot?(
    folderId: string,
    selection: { kind: "changes" | "branch"; baseRef?: string; headRef?: string },
  ): Promise<ReviewSnapshot>;
  run(folderId: string, program: "git" | "gh", args: string[]): Promise<GitResult>;
}

export const tauriGit: GitApi = {
  reviewChild: (parentId, childId) => invoke("code_child_review", { parentId, childId }),
  planIntegration: (parentId, commits) =>
    invoke("code_child_integration_plan", { parentId, commits }),
  applyChildReview: (token) => invoke("code_child_apply", { token }),
  childAttempts: (parentId) => invoke("code_child_attempts", { parentId }),
  discardChildReview: (parentId, token) => invoke("code_child_discard", { parentId, token }),
  childBase: (parentId) => invoke("code_worktree_base", { parentId }),
  prepareChildren: (request) => invoke("code_worktree_prepare", { request }),
  snapshot: (folderId, selection) => invoke("repo_review_snapshot", { folderId, selection }),
  run: (folderId, program, args) => invoke<GitResult>("repo_git", { folderId, program, args }),
};
