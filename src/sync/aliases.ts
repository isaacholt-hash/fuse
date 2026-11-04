import type { Tenant } from "@/storage/defaults";
import type { SqlDb } from "@/storage/sql";

/** Natural-key reconciliation preserves earlier IDs as aliases for stored/UI references. */
export async function resolveArtifactId(db: SqlDb, tenant: Tenant, id: string): Promise<string> {
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const rows = await db.select<{ canonical_id: string }>(
      "SELECT canonical_id FROM sync_aliases WHERE workspace_id=? AND table_name='artifacts' AND original_id=?",
      [tenant.workspaceId, current],
    );
    const next = rows[0]?.canonical_id;
    if (!next || next === current) return current;
    current = next;
  }
  throw new Error("Artifact identity aliases contain a cycle.");
}
