// M10 step 14: what the home screen shows, from what the app already loads.
import type { ApprovalRequest } from "@/agent/run";
import type { HandedOver } from "@/handover/watch";
import type { HandoverState } from "@/handover/handover";
import type { RecentRun } from "@/storage/runs";
import type { Schedule } from "@/storage/schedules";
import type { HomeRun, HomeSchedule, HomeView } from "@/ui/Home";

/** The first line of what a run is asking. */
export function questionLine(req: ApprovalRequest): string {
  switch (req.kind) {
    case "command":
      return `Run ${req.command}`;
    case "edit":
      return `Change ${req.change.path}`;
    case "git":
      return req.summary;
    case "fetch":
      return `Read ${req.url}`;
    case "python":
      return "Run a Python script";
    case "mcp":
      return `${req.server}: ${req.tool}`;
    case "organise":
      return `Reorganise ${String(req.moves.length)} files`;
    case "network":
      return `Let ${req.command} use the network`;
  }
}

/** "Today 18:00", "Tomorrow 07:30", or "Mon 3 Nov 09:00". */
export function whenLabel(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const day = (t: number) => new Date(t).toDateString();
  if (day(at) === day(now)) return `Today ${time}`;
  if (day(at) === day(now + 86_400_000)) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

export const EMPTY_HOME: HomeView = { waiting: [], going: [], scheduled: [], today: null };

export function homeView(input: {
  recent: readonly RecentRun[];
  /** Questions nobody has answered yet, by run id. */
  questions: ReadonlyMap<string, ApprovalRequest>;
  /** This desktop's handovers and their last state on HULK (desktop only). */
  handovers?: readonly HandedOver[];
  hulkStates?: ReadonlyMap<string, HandoverState>;
  schedules: readonly Schedule[];
  /** Whether this app's own runs go on HULK (the web app). */
  web: boolean;
  /** Threads this app can open. */
  openable: ReadonlySet<string>;
  spentToday: number;
  dayBudget: number | null;
  now: number;
}): HomeView {
  const place = input.web ? ("hulk" as const) : ("local" as const);
  const open = (id: string | null) => (id && input.openable.has(id) ? id : null);
  const waiting: HomeRun[] = [];
  const going: HomeRun[] = [];
  for (const r of input.recent) {
    if (r.status !== "running") continue;
    const q = input.questions.get(r.id);
    const row: HomeRun = {
      id: r.id,
      threadId: open(r.threadId),
      title: r.threadTitle ?? r.task,
      detail: q ? questionLine(q) : r.task,
      activeSince: q ? null : r.startedAt + r.waitedMs,
      spentMicro: r.spentMicroUsd,
      place,
    };
    (q ? waiting : going).push(row);
  }
  for (const h of input.handovers ?? []) {
    const s = input.hulkStates?.get(h.requestId);
    if (!s) continue;
    const row: HomeRun = {
      id: h.requestId,
      threadId: open(h.threadId),
      title: h.task,
      detail: s.waiting ? "A question on HULK" : s.status === "queued" ? "Starting" : null,
      activeSince: null,
      spentMicro: null,
      place: "hulk",
    };
    if (s.status === "running" && s.waiting) waiting.push(row);
    else if (s.status === "running" || s.status === "queued") going.push(row);
  }
  const scheduled: HomeSchedule[] = input.schedules
    .filter((s) => s.enabled && s.nextAt !== null && s.nextAt > input.now)
    .sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0))
    .map((s) => ({
      id: s.id,
      name: s.name,
      when: whenLabel(s.nextAt ?? 0, input.now),
      where: "HULK",
      threadId: open(s.lastThreadId),
    }));
  return {
    waiting,
    going,
    scheduled,
    today:
      input.spentToday > 0 || input.dayBudget !== null
        ? { spentMicro: input.spentToday, budgetMicro: input.dayBudget }
        : null,
  };
}
