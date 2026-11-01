// M10 step 15: the words and drafts the scheduled-task section and the Scheduled page share.
import type { Schedule, ScheduleInput } from "@/storage/schedules";
import type { RunKind, RunMode } from "@/storage/runs";

/** What a new task starts with: the project's kind, mode and model, and the usual cost cap. */
export interface ScheduleDefaults {
  kind: RunKind;
  mode: RunMode;
  model: { provider: string; id: string };
  capMicroUsd: number;
}

/** A task as the form edits it: everything but its project. */
export type Draft = Omit<ScheduleInput, "projectId">;

export const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** A new task: daily at 09:00 on the project's defaults (a one-off would be the next hour). */
export function freshDraft(defaults: ScheduleDefaults, now: number): Draft {
  const at = new Date(now + 3_600_000);
  at.setMinutes(0, 0, 0);
  return {
    name: "",
    prompt: "",
    kind: defaults.kind,
    mode: defaults.mode,
    provider: defaults.model.provider,
    model: defaults.model.id,
    capMicroUsd: defaults.capMicroUsd,
    repeat: "daily",
    onceAt: at.getTime(),
    minute: 9 * 60,
    weekday: 1,
  };
}

/** A task as the form shows it to edit. */
export function draftOf(s: Schedule): Draft {
  return {
    name: s.name,
    prompt: s.prompt,
    kind: s.kind,
    mode: s.mode,
    provider: s.provider,
    model: s.model,
    capMicroUsd: s.capMicroUsd,
    repeat: s.repeat,
    onceAt: s.onceAt,
    minute: s.minute,
    weekday: s.weekday,
  };
}

export function lastLine(s: Schedule): { text: string; failed: boolean } | null {
  if (s.lastAt === null) return null;
  const at = when(s.lastAt);
  switch (s.lastStatus) {
    case null:
      return { text: `Started ${at}`, failed: false };
    case "done":
      return { text: `Last run ${at}: done`, failed: false };
    case "error":
      return { text: `Last run ${at} failed: ${s.lastNote ?? "no reason given"}`, failed: true };
    default:
      return {
        text: `Last run ${at}: ${s.lastStatus}${s.lastNote ? ` (${s.lastNote})` : ""}`,
        failed: false,
      };
  }
}

export type ScheduleStatus = "active" | "paused" | "done" | "idle";

/** A task's chip: on with a next time, switched off, a one-off that ran, or neither. */
export function scheduleStatus(s: Schedule): ScheduleStatus {
  if (!s.enabled) return "paused";
  if (s.nextAt !== null) return "active";
  if (s.repeat === "once" && s.lastAt !== null) return "done";
  return "idle";
}
