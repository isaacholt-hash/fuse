/** Paths and execution claims never leave their owner; only the run relationship is portable. */
export interface ChildBase {
  commit: string;
  statusHash: string;
  folderId: string;
}
export interface ChildPreparation {
  parentId: string;
  modelStepId: string;
  callId: string;
  base: ChildBase;
  tasks: string[];
}
export interface PreparedChild {
  id: string;
  state: "creating" | "ready" | "running" | "complete" | "interrupted" | "failed";
}

export interface ChildFileDiff {
  path: string;
  before: string | null;
  after: string | null;
  mode: string;
}
export interface ChildCommitPin {
  childId: string;
  commit: string;
}
export interface ChildReviewSnapshot {
  id: string;
  parentId: string;
  childId: string | null;
  parentBase: ChildBase;
  indexHash: string;
  childHead: string | null;
  files: ChildFileDiff[];
  commits: ChildCommitPin[];
}
export interface ChildReviewResult {
  commit: string;
  branch: string;
  path: string;
}
export interface ChildReviewAttempt {
  id: string;
  kind: "child" | "integration";
  state: "review" | "working" | "committed" | "complete" | "failed";
  childId: string | null;
  result: ChildReviewResult | null;
}
export interface ParallelApi {
  reviewChild(parentId: string, childId: string): Promise<ChildReviewSnapshot>;
  planIntegration(parentId: string, commits: ChildCommitPin[]): Promise<ChildReviewSnapshot>;
  applyChildReview(token: string): Promise<ChildReviewResult>;
  childAttempts(parentId: string): Promise<ChildReviewAttempt[]>;
  discardChildReview(parentId: string, token: string): Promise<void>;
}
export interface ParallelChildView {
  id: string;
  task: string;
  status: "running" | "paused" | "done" | "stopped" | "error";
  branch: string | null;
  plan: string | null;
  planner: string | null;
  spentMicroUsd: number;
  note: string | null;
  steps: number;
  latest: string | null;
}
export interface ParallelView {
  children: ParallelChildView[];
  spentMicroUsd: number;
  heldMicroUsd: number;
  capMicroUsd: number;
}
