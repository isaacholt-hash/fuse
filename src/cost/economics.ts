/**
 * Cost per successful task (LL-07). Pure: storage supplies the tasks, this sums them.
 *
 * A task is one question: every answer to it (regenerates, stronger re-runs) and every attempt
 * behind those answers count once. It succeeded when its newest answer finished, wasn't marked
 * bad, and the question wasn't edited and asked again. All spend in the period, housekeeping
 * included, is divided by the tasks that succeeded.
 */

export interface TaskAnswer {
  status: "complete" | "streaming" | "stopped" | "error";
  feedback: "up" | "down" | null;
}

export interface TaskRecord {
  /** Oldest first. */
  answers: TaskAnswer[];
  /** A newer version of the question exists (an edit adds a sibling). */
  edited: boolean;
}

export function taskSucceeded(task: TaskRecord): boolean {
  const last = task.answers.at(-1);
  return !task.edited && last?.status === "complete" && last.feedback !== "down";
}

export interface Economics {
  tasks: number;
  succeeded: number;
  /** Everything billed in the period, in micro-dollars. */
  spent: number;
  /** Null until a task has succeeded. */
  perSuccess: number | null;
  /** Requests answered without a cloud call (a local model, or no model at all). */
  cloudCallsAvoided: number;
}

export function economics(
  tasks: readonly TaskRecord[],
  spent: number,
  cloudCallsAvoided: number,
): Economics {
  const succeeded = tasks.filter(taskSucceeded).length;
  return {
    tasks: tasks.length,
    succeeded,
    spent,
    perSuccess: succeeded > 0 ? Math.round(spent / succeeded) : null,
    cloudCallsAvoided,
  };
}

/** The cloud-only figure later numbers are measured against, frozen once (LL-07, LL-09). */
export interface EconomicsBaseline {
  /** When it was frozen. */
  at: number;
  days: number;
  tasks: number;
  succeeded: number;
  perSuccess: number;
}

export function parseBaseline(raw: string | null): EconomicsBaseline | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<EconomicsBaseline>;
    return typeof v.at === "number" &&
      typeof v.days === "number" &&
      typeof v.tasks === "number" &&
      typeof v.succeeded === "number" &&
      typeof v.perSuccess === "number"
      ? (v as EconomicsBaseline)
      : null;
  } catch {
    return null;
  }
}

/** Percent change against the baseline, rounded; null when either side is missing. */
export function againstBaseline(
  now: number | null,
  baseline: EconomicsBaseline | null,
): number | null {
  if (now === null || !baseline || baseline.perSuccess <= 0) return null;
  return Math.round(((now - baseline.perSuccess) / baseline.perSuccess) * 100);
}
