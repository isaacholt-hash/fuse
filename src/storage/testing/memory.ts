import type { Memory } from "../memories";

/** A saved memory for unit tests: an active global fact you typed, unless overridden. */
export const fakeMemory = (m: Pick<Memory, "id" | "text"> & Partial<Memory>): Memory => ({
  kind: "fact",
  scope: m.projectId ? "project" : "global",
  projectId: null,
  threadId: null,
  authority: "you",
  status: "active",
  sourceThreadId: null,
  sourceThreadTitle: null,
  extractionMethod: "typed",
  extractionModel: null,
  confidence: 100,
  sensitivity: "normal",
  maySend: true,
  expiresAt: null,
  lastVerifiedAt: null,
  revision: 1,
  rationale: null,
  alternatives: [],
  taskStatus: null,
  dependsOn: [],
  supersededById: null,
  createdAt: 0,
  updatedAt: 0,
  ...m,
});
