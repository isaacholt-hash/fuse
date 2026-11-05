import { useEffect } from "react";
import type { Tenant } from "@/storage/defaults";
import type { LatestRun } from "@/storage/runs";
import type { SqlDb } from "@/storage/sql";
import { markThreadSeen } from "@/storage/threads";

/** Observe scalar revisions, rather than restarting a write after every sidebar refresh. */
export function useSeenResult(
  db: SqlDb,
  tenant: Tenant,
  threadId: string | null,
  latest: LatestRun | undefined,
  seenAt: number | null | undefined,
  refresh: () => Promise<void>,
): void {
  const updatedAt = latest?.updatedAt;
  const status = latest?.status;
  useEffect(() => {
    if (!threadId || updatedAt === undefined || status === undefined || status === "running")
      return;
    if (seenAt === 0 || (seenAt ?? 0) >= updatedAt) return;
    let live = true;
    void markThreadSeen(db, tenant, threadId, Math.max(Date.now(), updatedAt), seenAt ?? null)
      .then(async () => {
        if (live) await refresh();
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [db, tenant, threadId, updatedAt, status, seenAt, refresh]);
}
