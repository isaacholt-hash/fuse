import type { GoldenPrompt } from "@/routing/golden";
import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

interface GoldenRow {
  prompt: string;
  expected_tier: GoldenPrompt["expectedTier"];
  intent: GoldenPrompt["intent"];
  complexity: GoldenPrompt["complexity"];
  needs_context: number;
  notes: string;
}

/** The routing test set in file order (RT-16). */
export async function listGoldenPrompts(db: SqlDb, tenant: Tenant): Promise<GoldenPrompt[]> {
  const rows = await db.select<GoldenRow>(
    `SELECT prompt, expected_tier, intent, complexity, needs_context, notes FROM golden_prompts
     WHERE workspace_id = ? ORDER BY position`,
    [tenant.workspaceId],
  );
  return rows.map((r) => ({
    prompt: r.prompt,
    expectedTier: r.expected_tier,
    intent: r.intent,
    complexity: r.complexity,
    needsContext: r.needs_context === 1,
    notes: r.notes,
  }));
}

/** Replaces the whole set with an imported file's prompts. */
export async function replaceGoldenPrompts(
  db: SqlDb,
  tenant: Tenant,
  prompts: readonly GoldenPrompt[],
): Promise<void> {
  const now = Date.now();
  await db.execute("DELETE FROM golden_prompts WHERE workspace_id = ?", [tenant.workspaceId]);
  for (const [i, p] of prompts.entries()) {
    await db.execute(
      `INSERT INTO golden_prompts (id, workspace_id, user_id, prompt, expected_tier, intent,
         complexity, needs_context, notes, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv7(),
        tenant.workspaceId,
        tenant.userId,
        p.prompt,
        p.expectedTier,
        p.intent,
        p.complexity,
        p.needsContext ? 1 : 0,
        p.notes,
        i + 1,
        now,
        now,
      ],
    );
  }
}
