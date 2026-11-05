export type ReviewSource =
  | { kind: "changes"; folderId: string }
  | { kind: "branch"; folderId: string; baseRef: string; headRef: string }
  | {
      kind: "github";
      serverId: string;
      installationId: number;
      owner: string;
      repo: string;
      number: number;
    };
export interface ReviewFile {
  path: string;
  oldRevision: string;
  newRevision: string;
  oldText: string | null;
  newText: string | null;
  changedOld: number[];
  changedNew: number[];
}
export interface ReviewSnapshot {
  protocol: 1;
  id: string;
  label: string;
  baseCommit: string;
  headCommit: string;
  files: ReviewFile[];
  limitations: string[];
}
export interface ReviewFinding {
  severity: "P0" | "P1" | "P2" | "P3";
  title: string;
  consequence: string;
  path: string;
  side: "old" | "new";
  revision: string;
  startLine: number;
  endLine: number;
  quote: string;
}
export interface ReviewReport {
  snapshotId: string;
  findings: ReviewFinding[];
  limitations: string[];
}
export interface ReviewState {
  version: 1;
  source: ReviewSource;
  snapshot: ReviewSnapshot;
  stage: "plan" | "analysis" | "final" | "finished";
  worker: { provider: string; id: string };
  best: { provider: string; id: string };
  plan: string | null;
  analysis: string | null;
  report: ReviewReport | null;
}
