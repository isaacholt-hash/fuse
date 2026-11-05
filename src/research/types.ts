import type { CatalogModel, ProviderId } from "@/catalog/catalog";
import type { SearchCall } from "@/providers/search";

export interface ResearchSelection {
  /** No implicit context. Sources must remain visible, permitted and in scope on every send. */
  memoryIds: string[];
  artifactIds: string[];
  messageIds: string[];
  instructions: ("global" | "project" | "thread")[];
}
export const EMPTY_SELECTION: ResearchSelection = {
  memoryIds: [],
  artifactIds: [],
  messageIds: [],
  instructions: [],
};
export interface ModelRef {
  provider: ProviderId;
  id: string;
}
export const modelRef = (model: CatalogModel): ModelRef => ({
  provider: model.provider,
  id: model.id,
});
export interface ResearchSource {
  id: string;
  url: string;
  finalUrl: string | null;
  title: string | null;
  query: string;
  foundAt: number;
  fetchedAt: number | null;
  text: string | null;
  truncated: boolean;
  error: string | null;
  flags: { why: string; passage: string }[];
}
export interface ResearchFinding {
  query: string;
  text: string;
  calls: SearchCall[];
}
export interface ResearchClaim {
  id: string;
  text: string;
  evidence: { sourceId: string; quote: string }[];
  supported: boolean;
  warning: string | null;
}
export interface ResearchReport {
  title: string;
  claims: ResearchClaim[];
  limitations: string[];
  disagreements: string[];
}
export type ResearchStage =
  "plan" | "search" | "read" | "synthesis" | "verify" | "publish" | "finished";
export interface ResearchState {
  version: 1;
  requestFingerprint: string;
  stage: ResearchStage;
  selection: ResearchSelection;
  worker: ModelRef;
  best: ModelRef;
  location: "desktop" | "hulk";
  pinned: boolean;
  queries: string[];
  queryIndex: number;
  sources: ResearchSource[];
  findings: ResearchFinding[];
  modelCalls: number;
  searches: number;
  reads: number;
  elapsedMs: number;
  contextFingerprint: string | null;
  report: ResearchReport | null;
  markdown: string | null;
  partialReason: string | null;
  incompleteReason: string | null;
  warnings: string[];
}
export interface ResearchOperation {
  id: string;
  seq: number;
  kind: "plan" | "search" | "read" | "synthesis" | "verify";
  state: "pending" | "complete" | "unknown" | "lost" | "not_dispatched";
  input: string;
  result: string | null;
}
