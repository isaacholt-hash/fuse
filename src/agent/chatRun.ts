// A coding run as a chat answer (M6 step 5b). The question is saved like any other; the answer
// is the run. While it works, the answer shows its steps; when it ends, the answer holds the
// run's final text and its total cost, so the thread, project and month totals include it.
import type { CatalogModel } from "@/catalog/catalog";
import { addMessage, finishMessage, listPath, markStreaming } from "@/storage/messages";
import { listRecentRequests } from "@/storage/requestLog";
import { getRun, listSteps, type Run } from "@/storage/runs";
import { setActiveLeaf } from "@/storage/threads";
import { EMPTY_USAGE, type Usage } from "@/storage/usage";
import { continueRun, runAnswer, startRun, type RunDeps, type RunProgress } from "./run";

export interface ChatRunInput {
  threadId: string;
  projectId: string;
  task: string;
  model: CatalogModel;
  capMicroUsd?: number;
  signal?: AbortSignal;
  /** Called first with the answer's id (before any step), then as the run goes. */
  onProgress?: (answerId: string, p: RunProgress) => void;
}

/** What the run cost, summed from its logged turns. */
async function runUsage(deps: RunDeps, run: Run): Promise<Usage> {
  const rows = (await listRecentRequests(deps.db, deps.tenant, 10_000)).filter(
    (r) => r.purpose === "agent" && r.messageId === run.messageId,
  );
  const sum = (f: (u: Usage) => number) => rows.reduce((n, r) => n + f(r.usage), 0);
  return {
    ...EMPTY_USAGE,
    inputTokens: sum((u) => u.inputTokens),
    outputTokens: sum((u) => u.outputTokens),
    cachedInputTokens: sum((u) => u.cachedInputTokens),
    cacheWriteTokens: sum((u) => u.cacheWriteTokens),
    reasoningTokens: sum((u) => u.reasoningTokens),
    costMicroUsd: run.spentMicroUsd,
    priceVersion: rows.find((r) => r.usage.priceVersion)?.usage.priceVersion ?? null,
    latencyMs: sum((u) => u.latencyMs ?? 0),
  };
}

/** The answer's final state from the run. */
async function finishFromRun(deps: RunDeps, run: Run): Promise<void> {
  if (!run.messageId) return;
  const steps = await listSteps(deps.db, deps.tenant, run.id);
  const answer = runAnswer(steps);
  await finishMessage(deps.db, deps.tenant, run.messageId, {
    content: answer,
    status: run.status === "done" ? "complete" : run.status === "error" ? "error" : "stopped",
    usage: await runUsage(deps, run),
    errorCode: run.status === "done" ? null : run.status,
    errorMessage: run.note,
  });
}

/** Saves the question, starts the run as its answer, and finishes the answer from it. */
export async function startChatRun(deps: RunDeps, input: ChatRunInput): Promise<Run> {
  const { db, tenant } = deps;
  const { path } = await listPath(db, tenant, input.threadId);
  const questionId = await addMessage(db, tenant, {
    threadId: input.threadId,
    parentId: path.at(-1)?.id ?? null,
    role: "user",
    content: input.task,
  });
  const answerId = await addMessage(db, tenant, {
    threadId: input.threadId,
    parentId: questionId,
    role: "assistant",
    content: "",
    status: "streaming",
    provider: input.model.provider,
    model: input.model.id,
  });
  await setActiveLeaf(db, tenant, input.threadId, answerId);
  const run = await startRun(deps, {
    projectId: input.projectId,
    threadId: input.threadId,
    messageId: answerId,
    task: input.task,
    model: input.model,
    ...(input.capMicroUsd !== undefined ? { capMicroUsd: input.capMicroUsd } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    onProgress: (p) => input.onProgress?.(answerId, p),
  });
  await finishFromRun(deps, run);
  return run;
}

/** Goes on with a paused or stopped run in its answer; `raiseCapBy` when it hit its cap. */
export async function continueChatRun(
  deps: RunDeps,
  runId: string,
  input: {
    raiseCapBy?: number;
    signal?: AbortSignal;
    onProgress?: (answerId: string, p: RunProgress) => void;
  },
): Promise<Run> {
  const before = await getRun(deps.db, deps.tenant, runId);
  if (!before) throw new Error("Run not found");
  if (before.messageId) await markStreaming(deps.db, deps.tenant, before.messageId);
  const answerId = before.messageId ?? "";
  const run = await continueRun(deps, runId, {
    ...(input.raiseCapBy ? { raiseCapBy: input.raiseCapBy } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    onProgress: (p) => input.onProgress?.(answerId, p),
  });
  await finishFromRun(deps, run);
  return run;
}
