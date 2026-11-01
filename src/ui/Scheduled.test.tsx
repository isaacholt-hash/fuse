// M10 step 15: the Scheduled page.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Schedule } from "@/storage/schedules";
import { ScheduledScreen, type ScheduledRow } from "./Scheduled";
import { scheduleStatus } from "./scheduleText";

afterEach(cleanup);

const task = (over: Partial<Schedule>): Schedule => ({
  id: "s1",
  projectId: "p1",
  name: "Nightly link check",
  prompt: "Check the links",
  kind: "code",
  mode: "plan",
  provider: "anthropic",
  model: "m",
  capMicroUsd: 500_000,
  repeat: "daily",
  onceAt: null,
  minute: 22 * 60,
  weekday: null,
  enabled: true,
  nextAt: Date.now() + 3_600_000,
  lastRunId: "r1",
  lastThreadId: "t1",
  lastStatus: "done",
  lastNote: null,
  lastAt: Date.now() - 86_400_000,
  ...over,
});

const row = (over: Partial<Schedule>, extra: Partial<ScheduledRow> = {}): ScheduledRow => ({
  task: task(over),
  project: "Lighthouse",
  lastCostMicro: 120_000,
  runs: [
    { threadId: "t1", title: "Nightly link check · 1 Nov" },
    { threadId: "t0", title: "Nightly link check · 31 Oct" },
  ],
  ...extra,
});

function show(over: Partial<Parameters<typeof ScheduledScreen>[0]> = {}) {
  const props = {
    rows: [row({}), row({ id: "s2", name: "Weekly review", enabled: false, nextAt: null })],
    editable: true,
    unavailable: null,
    projects: [{ id: "p1", name: "Lighthouse" }],
    prompts: [{ id: "pr", name: "Release notes", body: "Write the release notes" }],
    models: [],
    defaultsFor: () => ({
      kind: "code" as const,
      mode: "ask" as const,
      model: { provider: "anthropic", id: "m" },
      capMicroUsd: 1_000_000,
    }),
    timeZone: "UTC",
    onSave: vi.fn(() => Promise.resolve(null)),
    onToggle: vi.fn(),
    onDelete: vi.fn(),
    onOpenChat: vi.fn(),
    onBack: vi.fn(),
    ...over,
  };
  render(<ScheduledScreen {...props} />);
  return props;
}

test("a task's chip: active, paused, a one-off that ran, or not scheduled", () => {
  expect(scheduleStatus(task({}))).toBe("active");
  expect(scheduleStatus(task({ enabled: false }))).toBe("paused");
  expect(scheduleStatus(task({ repeat: "once", nextAt: null }))).toBe("done");
  expect(scheduleStatus(task({ nextAt: null, lastAt: null }))).toBe("idle");
});

test("every task across projects, with its chip, project, last run and cost; pause, open, all runs", () => {
  const p = show();
  const list = within(screen.getByRole("list", { name: "Every scheduled task" }));
  expect(list.getByText("Active")).toBeInTheDocument();
  expect(list.getByText("Paused")).toBeInTheDocument();
  expect(list.getAllByText(/Lighthouse · Daily at 22:00 · on HULK/).length).toBe(2);
  expect(list.getAllByText(/\$0\.12/).length).toBeGreaterThan(0);
  fireEvent.click(list.getByRole("button", { name: "Pause Nightly link check" }));
  expect(p.onToggle).toHaveBeenCalledWith("s1", false);
  fireEvent.click(list.getByRole("button", { name: "Resume Weekly review" }));
  expect(p.onToggle).toHaveBeenCalledWith("s2", true);
  fireEvent.click(
    list.getByRole("button", { name: "Open the last session of Nightly link check" }),
  );
  expect(p.onOpenChat).toHaveBeenCalledWith("t1");
  fireEvent.click(list.getAllByRole("button", { name: "All 2 runs" })[0] as HTMLElement);
  fireEvent.click(screen.getByRole("button", { name: "Nightly link check · 31 Oct" }));
  expect(p.onOpenChat).toHaveBeenCalledWith("t0");
});

test("a new task can start from a saved prompt", () => {
  show();
  fireEvent.change(screen.getByLabelText("Start from a saved prompt"), {
    target: { value: "pr" },
  });
  fireEvent.click(screen.getByRole("button", { name: "New task" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByDisplayValue("Release notes")).toBeInTheDocument();
  expect(dialog.getByDisplayValue("Write the release notes")).toBeInTheDocument();
});

test("HULK's tasks on a paired desktop are read-only; unpaired, it says why", () => {
  show({ editable: false });
  expect(screen.getByText(/Add or change them in the web app on HULK/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Pause Nightly link check" })).toBeNull();
  expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
  cleanup();
  show({ editable: false, rows: null, unavailable: "Pair this computer with HULK first." });
  expect(screen.getByText("Pair this computer with HULK first.")).toBeInTheDocument();
  expect(screen.queryByText("Loading tasks…")).toBeNull();
});
