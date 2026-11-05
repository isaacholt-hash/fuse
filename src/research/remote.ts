/** Explicit transfer over authenticated native HTTPS. A lost acknowledgement is observed, never blindly resent. */
import type { HulkApi } from "@/handover/api";
import { hulkDb } from "@/handover/api";
import type { SqlDb } from "@/storage/sql";
import type { Tenant } from "@/storage/defaults";
import { askToStartWithId, getRequest, askToStop, type StartInput } from "@/storage/runQueue";
import { uuidv7 } from "@/storage/ids";
import { EMPTY_SELECTION, modelRef } from "./types";
import type { ResearchModels } from "./routing";
import { readTransfer, RESEARCH_PROTOCOL, type ResearchTransfer } from "./transfer";
import { researchStatus, type ResearchTaskView } from "./status";
export interface RemoteResearchLink {
  requestId: string;
  sourceThreadId: string;
  targetThreadId: string;
  address: string;
  task: string;
  capMicroUsd: number;
  createdAt: number;
  delivery: "prepared" | "dispatched" | "sent" | "unknown" | "withdrawn";
}
export async function remoteResearchLinks(
  db: SqlDb,
  tenant: Tenant,
): Promise<RemoteResearchLink[]> {
  return db.select<RemoteResearchLink>(
    "SELECT id requestId,source_thread_id sourceThreadId,target_thread_id targetThreadId,address,task,cap_micro_usd capMicroUsd,created_at createdAt,state delivery FROM research_transfers WHERE workspace_id=? AND user_id=? ORDER BY created_at",
    [tenant.workspaceId, tenant.userId],
  );
}
export async function startRemoteResearch(
  deps: { db: SqlDb; tenant: Tenant; hulk: HulkApi },
  input: {
    requestId: string;
    task: string;
    models: ResearchModels;
    capMicroUsd: number;
    transfer: ResearchTransfer;
  },
): Promise<RemoteResearchLink> {
  if (!Number.isSafeInteger(input.capMicroUsd) || input.capMicroUsd <= 0)
    throw new Error("Enter a research spending cap.");
  const setup = JSON.stringify({
    task: input.task,
    capMicroUsd: input.capMicroUsd,
    worker: modelRef(input.models.worker),
    best: modelRef(input.models.best),
    pinned: input.models.pinned,
    sourceThreadId: input.transfer.source.threadId,
    selection: input.transfer.source.selection,
  });
  const previous = (await remoteResearchLinks(deps.db, deps.tenant)).find(
    (link) => link.requestId === input.requestId,
  );
  if (previous) {
    if (previous.delivery === "withdrawn")
      throw new Error(
        "This research intent was withdrawn. Open a new setup to review the current scope.",
      );
    const saved = (
      await deps.db.select<{ setup: string }>(
        "SELECT setup FROM research_transfers WHERE workspace_id=? AND user_id=? AND id=?",
        [deps.tenant.workspaceId, deps.tenant.userId, input.requestId],
      )
    )[0];
    if (saved?.setup !== setup)
      throw new Error("Research request ID was reused with different models or context.");
    if (
      previous.task !== input.task ||
      previous.capMicroUsd !== input.capMicroUsd ||
      previous.sourceThreadId !== input.transfer.source.threadId
    )
      throw new Error("Research request ID was reused with a different scope.");
    // Even after restart, opening/repeating this setup cannot resend a possibly accepted request.
    return previous;
  }
  const status = await deps.hulk.status();
  if (!status.paired || !status.address)
    throw new Error("Pair with HULK in Settings before starting research there.");
  if (status.mismatch) throw new Error(status.mismatch);
  if (status.server?.researchProtocol !== RESEARCH_PROTOCOL)
    throw new Error(
      "Update HULK to a build with Research before starting. This computer remains an explicit option.",
    );
  const transfer = await readTransfer(input.transfer),
    targetThreadId = uuidv7();
  if (transfer.project) {
    const existing = await hulkDb(deps.hulk).select(
      "SELECT id FROM projects WHERE workspace_id=? AND id=? AND deleted_at IS NULL",
      [deps.tenant.workspaceId, transfer.project.id],
    );
    if (!existing.length)
      throw new Error(
        "This project is not available on HULK yet. Let its enrolled sync finish, or choose this computer.",
      );
  }
  const request: StartInput = {
    threadId: targetThreadId,
    projectId: transfer.source.projectId,
    task: input.task,
    kind: "research",
    model: modelRef(input.models.worker),
    planner: modelRef(input.models.best),
    capMicroUsd: input.capMicroUsd,
    research: {
      protocol: 1,
      selection: structuredClone(EMPTY_SELECTION),
      pinned: input.models.pinned,
      transfer,
    },
  };
  const now = Date.now(),
    { workspaceId: ws, userId: user } = deps.tenant;
  const saved = await deps.db.execute(
    "INSERT INTO research_transfers(id,workspace_id,user_id,source_thread_id,target_thread_id,address,task,cap_micro_usd,setup,input,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'prepared',?,?) ON CONFLICT(id) DO NOTHING",
    [
      input.requestId,
      ws,
      user,
      transfer.source.threadId,
      targetThreadId,
      status.address,
      input.task,
      input.capMicroUsd,
      setup,
      JSON.stringify(request),
      now,
      now,
    ],
  );
  if (saved.rowsAffected === 0)
    return (
      (await remoteResearchLinks(deps.db, deps.tenant)).find(
        (link) => link.requestId === input.requestId,
      ) ?? Promise.reject(new Error("Research intent was removed."))
    );
  const claimed = await deps.db.execute(
    `UPDATE research_transfers SET state='dispatched',updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND state='prepared'
    AND EXISTS(SELECT 1 FROM threads t WHERE t.workspace_id=research_transfers.workspace_id AND t.id=research_transfers.source_thread_id
      AND t.deleted_at IS NULL AND t.incognito=0 AND t.local_only=0
      AND (t.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.workspace_id=t.workspace_id AND p.privacy_mode!='local_only'))
      AND NOT EXISTS(SELECT 1 FROM (SELECT ? AS provider UNION SELECT ?) models WHERE COALESCE(
        (SELECT allow FROM egress_rules e WHERE e.workspace_id=t.workspace_id AND e.project_id=t.project_id AND e.provider=models.provider),
        (SELECT allow FROM egress_rules e WHERE e.workspace_id=t.workspace_id AND e.project_id IS NULL AND e.provider=models.provider),1)=0))`,
    [
      Date.now(),
      ws,
      user,
      input.requestId,
      input.models.worker.provider,
      input.models.best.provider,
    ],
  );
  if (claimed.rowsAffected !== 1) {
    await deps.db.execute(
      "UPDATE research_transfers SET state='withdrawn',input=NULL,updated_at=? WHERE workspace_id=? AND id=? AND state='prepared'",
      [Date.now(), ws, input.requestId],
    );
    throw new Error(
      "The source Chat or provider policy changed before transfer. Review research setup again.",
    );
  }
  try {
    await askToStartWithId(hulkDb(deps.hulk), deps.tenant, input.requestId, request);
    await deps.db.execute(
      "UPDATE research_transfers SET state='sent',input=NULL,updated_at=? WHERE workspace_id=? AND id=? AND state='dispatched'",
      [Date.now(), ws, input.requestId],
    );
  } catch {
    await deps.db.execute(
      "UPDATE research_transfers SET state='unknown',updated_at=? WHERE workspace_id=? AND id=? AND state='dispatched'",
      [Date.now(), ws, input.requestId],
    );
  }
  const link = (await remoteResearchLinks(deps.db, deps.tenant)).find(
    (item) => item.requestId === input.requestId,
  );
  if (!link) throw new Error("The source Chat was removed; no automatic delivery will occur.");
  return link;
}
export async function remoteResearchStatus(
  hulk: HulkApi,
  tenant: Tenant,
  link: RemoteResearchLink,
  localDb?: SqlDb,
): Promise<ResearchTaskView> {
  const status = await hulk.status();
  if (!status.paired || status.address !== link.address)
    throw new Error(
      "Pair with the original HULK installation to view or control this research task.",
    );
  if (status.mismatch) throw new Error(status.mismatch);
  const db = hulkDb(hulk),
    request = await getRequest(db, tenant, link.requestId);
  if (request && localDb)
    await localDb.execute(
      "UPDATE research_transfers SET state='sent',input=NULL,updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND state IN ('prepared','dispatched','unknown')",
      [Date.now(), tenant.workspaceId, tenant.userId, link.requestId],
    );
  const run = request?.runId ? await researchStatus(db, tenant, request.runId, "hulk") : null;
  if (run) return run;
  const uncertain = !request;
  return {
    id: link.requestId,
    threadId: link.targetThreadId,
    title: link.task,
    status: request?.status === "failed" ? "error" : uncertain ? "error" : "queued",
    stage: null,
    searches: null,
    reads: null,
    modelCalls: null,
    spentMicroUsd: 0,
    heldMicroUsd: 0,
    unknownMicroUsd: 0,
    capMicroUsd: link.capMicroUsd,
    note:
      request?.error ??
      (request
        ? "Waiting for HULK's runner."
        : "Delivery could not be confirmed. Check HULK before explicitly starting another task; this request will not be resent automatically."),
    readOnly: false,
    location: "hulk",
    pauseRequested: false,
    statusUnknown: uncertain,
  };
}
export async function stopQueuedResearch(db: SqlDb, tenant: Tenant, runId: string): Promise<void> {
  const cancelled = await db.execute(
    "UPDATE run_requests SET status='failed',error='Cancelled before research started.',updated_at=? WHERE workspace_id=? AND user_id=? AND id=? AND status='queued' AND kind='start' AND json_extract(input,'$.kind')='research'",
    [Date.now(), tenant.workspaceId, tenant.userId, runId],
  );
  if (cancelled.rowsAffected === 0) await askToStop(db, tenant, runId);
}
