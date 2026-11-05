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
