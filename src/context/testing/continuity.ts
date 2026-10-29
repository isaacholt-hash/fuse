// The two-provider continuity benchmark (PM-19): recorded project histories in data/continuity/,
// built into a database the way FUSE would hold them, so the automated test and Isaac's live run
// (`pnpm continuity:live`) ask the same questions of the same context.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tenant } from "@/storage/defaults";
import { addDecision, addMemory, addTask, type MemoryKind } from "@/storage/memories";
import { addMessage } from "@/storage/messages";
import { createProject, updateProject } from "@/storage/projects";
import { setMemorySettings } from "@/storage/settings";
import type { SqlDb } from "@/storage/sql";
import { addSummary } from "@/storage/summaries";
import { createThread, setActiveLeaf, setThreadProject } from "@/storage/threads";

export interface Scenario {
  id: string;
  description: string;
  project: { name: string; instructions: string };
  decisions: { id: string; text: string; rationale: string; alternatives: string[] }[];
  constraints: { id: string; text: string }[];
  tasks: string[];
  memories: { text: string; kind: MemoryKind }[];
  history: { role: "user" | "assistant"; content: string }[];
  /** A summary of the history; when set, the history is sent as this summary (PM-06). */
  summary: string | null;
  /**
   * Questions a model should answer from the context. `expect`: every term must appear in the
   * answer (case-insensitive); `a|b` accepts either. `critical`: the decision or constraint
   * it tests.
   */
  questions: { ask: string; expect: string[]; critical: string }[];
}

const DIR = join(import.meta.dirname, "../../../data/continuity");

export function loadScenarios(): Scenario[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Scenario);
}

/** True when the answer contains every expected term (one of `a|b`). */
export function answerPasses(answer: string, expect: readonly string[]): boolean {
  const text = answer.toLowerCase();
  return expect.every((term) => term.split("|").some((alt) => text.includes(alt.toLowerCase())));
}

/** Unrelated facts that compete for the memory budget, to show decisions aren't cut. */
const FILLER = Array.from(
  { length: 40 },
  (_, i) => `Has visited town number ${String(i + 1)} on a long walking holiday years ago.`,
);

/**
 * Builds the scenario in `db`: the project with its instructions, decisions, constraints, tasks
 * and memories, and a chat holding the history (summarized when the scenario has a summary).
 * With `crowded`, the memory budget is tiny and full of filler, as in a long-lived workspace.
 */
export async function buildScenario(
  db: SqlDb,
  tenant: Tenant,
  s: Scenario,
  { crowded = false }: { crowded?: boolean } = {},
): Promise<{ threadId: string; projectId: string }> {
  const project = await createProject(db, tenant, s.project.name);
  await updateProject(db, tenant, project.id, {
    name: s.project.name,
    instructions: s.project.instructions,
    defaultModel: null,
  });
  for (const d of s.decisions) {
    await addDecision(db, tenant, project.id, {
      text: d.text,
      rationale: d.rationale,
      alternatives: d.alternatives,
    });
  }
  for (const c of s.constraints) {
    await addMemory(db, tenant, { text: c.text, kind: "constraint", projectId: project.id });
  }
  for (const task of s.tasks) await addTask(db, tenant, project.id, task);
  for (const m of s.memories) await addMemory(db, tenant, { text: m.text, kind: m.kind });
  if (crowded) {
    for (const text of FILLER) await addMemory(db, tenant, { text, kind: "fact" });
    await setMemorySettings(db, tenant, { suggest: false, budgetTokens: 60 });
  }
  const thread = await createThread(db, tenant, s.project.name);
  await setThreadProject(db, tenant, thread.id, project.id);
  let parentId: string | null = null;
  for (const h of s.history) {
    parentId = await addMessage(db, tenant, {
      threadId: thread.id,
      parentId,
      role: h.role,
      content: h.content,
    });
  }
  if (parentId) {
    await setActiveLeaf(db, tenant, thread.id, parentId);
    if (s.summary) await addSummary(db, tenant, thread.id, parentId, s.summary);
  }
  return { threadId: thread.id, projectId: project.id };
}
