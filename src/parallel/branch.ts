/** "fuse/child/4b1ce1a0-b1d6-…" as "fuse/child/4b1ce1a0": a UUID shortens to its first block. */
export function shortBranch(branch: string): string {
  return branch.replace(
    /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "$1",
  );
}

/** A task's first line, short enough for a header: no trailing full stop, at most 60 characters. */
export function firstLine(task: string): string {
  const line = (task.trim().split("\n")[0] ?? "").replace(/[.;:,]+$/, "");
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** A task as the run card names it: "Task 2 · Write beta". */
export function taskLabel(tasks: readonly { id: string; task: string }[], id: string): string {
  const i = tasks.findIndex((t) => t.id === id);
  return i < 0 ? "the task" : `Task ${String(i + 1)} · ${firstLine(tasks[i]?.task ?? "")}`;
}
