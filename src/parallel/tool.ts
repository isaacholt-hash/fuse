import type { ToolSpec } from "@/providers/types";

export const DELEGATE_CODE_TOOL: ToolSpec = {
  name: "delegate_code",
  description:
    "Propose one to three independent Code tasks for children in isolated worktrees at the parent's committed HEAD. Always asks for approval. Children share this run's spending cap and execution owner, cannot delegate or use Git directly. Their edits stay separate for later review and approved parent integration. Uncommitted parent changes are excluded. Available only in writable Code runs with Git and the OS sandbox.",
  schema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: { type: "string", minLength: 1, maxLength: 16384 },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
};

export function childTasks(input: Record<string, unknown>): string[] {
  const tasks = input.tasks;
  if (
    Object.keys(input).some((k) => k !== "tasks") ||
    !Array.isArray(tasks) ||
    tasks.length < 1 ||
    tasks.length > 3 ||
    tasks.some(
      (t) =>
        typeof t !== "string" ||
        !t.trim() ||
        t.includes("\0") ||
        new TextEncoder().encode(t).length > 16384,
    )
  )
    throw new Error("Delegate one to three explicit tasks, bounded to 32 KiB total.");
  const text = tasks as string[];
  if (text.reduce((sum, t) => sum + new TextEncoder().encode(t).length, 0) > 32768)
    throw new Error("Delegated task text exceeds 32 KiB.");
  return text;
}
