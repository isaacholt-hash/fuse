/** Small owner status reads; never reload selected context/source bodies while polling. */
import type { SqlDb } from "@/storage/sql";
import type { Tenant } from "@/storage/defaults";
import { getRun } from "@/storage/runs";
import { runExposure } from "@/storage/requestBudget";
import type { ResearchStage } from "./types";
export interface ResearchTaskView {
  statusUnknown?: boolean;
  id: string;
  threadId: string | null;
  title: string;
  status: "queued" | "running" | "paused" | "stopped" | "done" | "error";
  stage: ResearchStage | null;
  searches: number | null;
  reads: number | null;
  modelCalls: number | null;
  spentMicroUsd: number;
  heldMicroUsd: number;
  unknownMicroUsd: number;
  capMicroUsd: number;
  note: string | null;
  readOnly: boolean;
  location: "desktop" | "hulk";
  pauseRequested: boolean;
}
export async function researchStatus(
  db: SqlDb,
  tenant: Tenant,
  runId: string,
  location: "desktop" | "hulk",
): Promise<ResearchTaskView | null> {
  const run = await getRun(db, tenant, runId);
  if (!run || run.kind !== "research") return null;
  const row = (
    await db.select<{
      stage: ResearchStage;
      searches: number;
      reads: number;
      modelCalls: number;
      pause_requested: number;
    }>(
      "SELECT json_extract(data,'$.stage') stage,json_extract(data,'$.searches') searches,json_extract(data,'$.reads') reads,json_extract(data,'$.modelCalls') modelCalls,pause_requested FROM research_state WHERE workspace_id=? AND user_id=? AND run_id=?",
      [tenant.workspaceId, tenant.userId, run.id],
    )
  )[0];
  const exposure = run.readOnly ? { held: 0 } : await runExposure(db, tenant, run.id);
  const unknown = run.readOnly
    ? 0
    : ((
        await db.select<{ amount: number }>(
          "SELECT COALESCE(SUM(MAX(h.bound_micro_usd-COALESCE(l.cost_micro_usd,0),0)),0) amount FROM request_reservations h LEFT JOIN request_log l ON l.id=h.request_id AND l.workspace_id=h.workspace_id WHERE h.workspace_id=? AND h.user_id=? AND h.run_id=? AND h.state='unknown'",
          [tenant.workspaceId, tenant.userId, run.id],
        )
      )[0]?.amount ?? 0);
  return {
    id: run.id,
    threadId: run.threadId,
    title: run.task,
    status: run.status,
    stage: row?.stage ?? null,
    searches: row?.searches ?? null,
    reads: row?.reads ?? null,
    modelCalls: row?.modelCalls ?? null,
    spentMicroUsd: run.spentMicroUsd,
    heldMicroUsd: exposure.held,
    unknownMicroUsd: unknown,
    capMicroUsd: run.capMicroUsd,
    note: run.note,
    readOnly: Boolean(run.readOnly),
    location,
    pauseRequested: row?.pause_requested === 1,
  };
}
