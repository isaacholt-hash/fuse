import type { Tenant } from "./defaults";
import { uuidv7 } from "./ids";
import type { SqlDb } from "./sql";

/** Global custom instructions (CH-05): sent with every message, on every model. */
export interface GlobalInstructions {
  aboutYou: string;
  howToAnswer: string;
}

export const NO_INSTRUCTIONS: GlobalInstructions = { aboutYou: "", howToAnswer: "" };

export async function getGlobalInstructions(
  db: SqlDb,
  tenant: Tenant,
): Promise<GlobalInstructions> {
  const rows = await db.select<{ about_you: string; how_to_answer: string }>(
    `SELECT about_you, how_to_answer FROM user_instructions WHERE workspace_id = ? AND user_id = ?`,
    [tenant.workspaceId, tenant.userId],
  );
  const row = rows[0];
  return row ? { aboutYou: row.about_you, howToAnswer: row.how_to_answer } : NO_INSTRUCTIONS;
}

export async function setGlobalInstructions(
  db: SqlDb,
  tenant: Tenant,
  value: GlobalInstructions,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO user_instructions
       (id, workspace_id, user_id, about_you, how_to_answer, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, user_id)
     DO UPDATE SET about_you = excluded.about_you, how_to_answer = excluded.how_to_answer,
                   updated_at = excluded.updated_at`,
    [
      uuidv7(now),
      tenant.workspaceId,
      tenant.userId,
      value.aboutYou.trim(),
      value.howToAnswer.trim(),
      now,
      now,
    ],
  );
}
