// @vitest-environment node
// M10 step 14: what the home screen shows.
import type { ApprovalRequest } from "@/agent/run";
import type { RecentRun } from "@/storage/runs";
import type { Schedule } from "@/storage/schedules";
import { homeView, questionLine, whenLabel } from "./homeView";

const run = (over: Partial<RecentRun>): RecentRun => ({
  id: "r",
  threadId: "t",
  threadTitle: "Fix the build",
  task: "Fix it",
  status: "running",
  note: null,
  createdAt: 1,
  updatedAt: 1,
  startedAt: 100,
  waitedMs: 20,
  spentMicroUsd: 42_000,
  ...over,
});

const schedule = (over: Partial<Schedule>): Schedule => ({
  id: "s",
  projectId: "p",
  name: "Nightly",
  prompt: "Check",
  kind: "code",
  mode: "plan",
  provider: "anthropic",
  model: "m",
  capMicroUsd: 1,
  repeat: "daily",
  onceAt: null,
  minute: 0,
  weekday: null,
  enabled: true,
  nextAt: 5_000,
  lastRunId: null,
  lastThreadId: null,
  lastStatus: null,
  lastNote: null,
  lastAt: null,
  ...over,
});

const base = {
  questions: new Map<string, ApprovalRequest>(),
  schedules: [] as Schedule[],
  web: false,
  openable: new Set(["t"]),
  spentToday: 0,
  dayBudget: null,
  now: 1_000,
};

test("runs going and runs waiting for you, with their question; ended runs aren't listed", () => {
  const view = homeView({
    ...base,
    recent: [
      run({ id: "a" }),
      run({ id: "b", threadId: "gone", threadTitle: null, task: "Tidy" }),
      run({ id: "c", status: "done" }),
    ],
    questions: new Map([["b", { kind: "command", command: "git push", runId: "b" }]]),
  });
  expect(view.going).toEqual([
    {
      id: "a",
      threadId: "t",
      title: "Fix the build",
      detail: "Fix it",
      activeSince: 120,
      spentMicro: 42_000,
      place: "local",
    },
  ]);
  // A chat this app can't open (it isn't listed here) has no Open.
  expect(view.waiting).toMatchObject([
    { id: "b", threadId: null, title: "Tidy", detail: "Run git push", activeSince: null },
  ]);
  expect(view.today).toBeNull();
});

test("the web app's runs are on HULK; a desktop's handovers come from its last look", () => {
  const web = homeView({ ...base, web: true, recent: [run({})] });
  expect(web.going[0]?.place).toBe("hulk");
  const desk = homeView({
    ...base,
    recent: [],
    handovers: [{ requestId: "h1", threadId: "t", task: "Ship it", at: 1 }],
    hulkStates: new Map([["h1", { status: "running", note: null, branch: null, waiting: true }]]),
  });
  expect(desk.waiting).toMatchObject([
    { id: "h1", title: "Ship it", place: "hulk", threadId: "t" },
  ]);
});

test("scheduled tasks: enabled ones still ahead, soonest first; today's spend against the day budget", () => {
  const view = homeView({
    ...base,
    recent: [],
    schedules: [
      schedule({ id: "late", name: "Weekly", nextAt: 9_000 }),
      schedule({ id: "off", name: "Off", enabled: false }),
      schedule({ id: "soon", name: "Nightly", nextAt: 2_000, lastThreadId: "t" }),
      schedule({ id: "past", name: "Past", nextAt: 500 }),
    ],
    spentToday: 250_000,
    dayBudget: 1_000_000,
  });
  expect(view.scheduled.map((s) => [s.id, s.where, s.threadId])).toEqual([
    ["soon", "HULK", "t"],
    ["late", "HULK", null],
  ]);
  expect(view.today).toEqual({ spentMicro: 250_000, budgetMicro: 1_000_000 });
});

test("a question's first line, and when a task runs next", () => {
  expect(questionLine({ kind: "git", summary: "Push fuse/x", remote: true, runId: "r" })).toBe(
    "Push fuse/x",
  );
  const noon = new Date(2026, 10, 1, 12, 0).getTime();
  expect(whenLabel(new Date(2026, 10, 1, 18, 5).getTime(), noon)).toBe("Today 18:05");
  expect(whenLabel(new Date(2026, 10, 2, 7, 30).getTime(), noon)).toBe("Tomorrow 07:30");
});
