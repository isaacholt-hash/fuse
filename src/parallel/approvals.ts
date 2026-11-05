import type { ApprovalRequest } from "@/agent/run";

/** Present one exact pending child approval; its answer callback retains its original ID. */
export function pendingApproval<T extends { request: ApprovalRequest }>(
  questions: ReadonlyMap<string, T>,
  runId: string,
): T | undefined {
  return (
    questions.get(runId) ?? [...questions.values()].find((q) => q.request.child?.parentId === runId)
  );
}
