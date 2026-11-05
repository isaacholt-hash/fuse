import type { ReviewFinding, ReviewSnapshot } from "../types";
export const snapshot: ReviewSnapshot = {
  protocol: 1,
  id: "a".repeat(64),
  label: "Recorded local change",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  files: [
    {
      path: "ratio.ts",
      oldRevision: "a".repeat(40),
      newRevision: "snapshot:" + "b".repeat(64),
      oldText: "return num / den;\n",
      newText: "return num / (den - 1);\n",
      changedOld: [1],
      changedNew: [1],
    },
  ],
  limitations: [],
};
export const finding: ReviewFinding = {
  severity: "P1",
  title: "Preserve the divisor",
  consequence: "When den is one, a finite ratio becomes Infinity because the divisor becomes zero.",
  path: "ratio.ts",
  side: "new",
  revision: "snapshot:" + "b".repeat(64),
  startLine: 1,
  endLine: 1,
  quote: "return num / (den - 1);",
};
