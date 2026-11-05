/** Typed requests on the existing owner-local runner queue; no repository handover. */
import type { StartInput } from "@/storage/runQueue";
import type { SqlDb } from "@/storage/sql";
import type { Tenant } from "@/storage/defaults";
import { getProject } from "@/storage/projects";
import { getThread } from "@/storage/threads";
import { readTransfer, RESEARCH_PROTOCOL, type ResearchTransfer } from "./transfer";
import { validateSelection } from "./context";
import type { ResearchSelection } from "./types";

export interface ResearchQueueInput {
  protocol: 1;
  selection: ResearchSelection;
  pinned: boolean;
  /** Present only for a deliberate desktop-to-HULK transfer; never an export of the project. */
  transfer?: ResearchTransfer;
}
export async function prepareQueuedResearch(
  deps: { db: SqlDb; tenant: Tenant },
  input: StartInput,
): Promise<ResearchQueueInput> {
  if (
    input.handover ||
    input.scheduleId ||
    input.newBranch ||
    (input.mode && input.mode !== "plan")
  )
    throw new Error("Research cannot use Code handover, schedules, branches or edit permissions.");
  const research = input.research;
  // Queue input is deserialized JSON; its protocol is not guaranteed by the TypeScript caller.
  const protocol = (research as unknown as Record<string, unknown> | undefined)?.protocol;
  if (!research || protocol !== RESEARCH_PROTOCOL || typeof research.pinned !== "boolean")
    throw new Error(
      "Research requires its restricted execution engine and a compatible setup request.",
    );
  validateSelection(research.selection);
  if (!input.threadId) throw new Error("Research needs a Chat destination.");
  if (!Number.isSafeInteger(input.capMicroUsd) || (input.capMicroUsd ?? 0) <= 0)
    throw new Error("Enter a research spending cap.");
  if (!input.planner) throw new Error("Research needs an explicit planning/synthesis model.");
  const transfer = research.transfer ? await readTransfer(research.transfer) : undefined;
  if (transfer) {
    if (input.projectId !== transfer.source.projectId)
      throw new Error("Research project does not match the reviewed context.");
    if (transfer.project && !(await getProject(deps.db, deps.tenant, transfer.project.id)))
      throw new Error(
        "This project is not available on HULK yet. Let its enrolled sync finish, or run research on this computer.",
      );
    const now = Date.now(),
      { workspaceId: ws, userId: user } = deps.tenant;
    // This creates only the dedicated Chat. It cannot replace shared project configuration.
    await deps.db.batch([
      {
        sql: "INSERT INTO threads(id,workspace_id,user_id,title,project_id,memory_injection,created_at,updated_at) VALUES(?,?,?,?,?,'off',?,?) ON CONFLICT(id) DO NOTHING",
        params: [
          input.threadId,
          ws,
          user,
          `Research: ${input.task.slice(0, 80)}`,
          input.projectId,
          now,
          now,
        ],
      },
    ]);
  }
  const target = await getThread(deps.db, deps.tenant, input.threadId);
  if (!target || target.kind !== "chat" || target.projectId !== input.projectId || target.incognito)
    throw new Error("The research destination is unavailable or changed.");
  return { ...research, ...(transfer ? { transfer } : {}) };
}
