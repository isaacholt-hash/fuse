// M10 step 9: Project settings → Scheduled tasks, on the real storage (an in-memory database).
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject } from "@/storage/projects";
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  setScheduleEnabled,
  type Schedule,
} from "@/storage/schedules";
import type { SqlDb } from "@/storage/sql";
import { openTestDb } from "@/storage/testing/nodeDb";
import { ScheduledTasksSection } from "./Schedules";
import type { ModelOption } from "./types";

afterEach(cleanup);

const t = DEFAULT_TENANT;
const models: ModelOption[] = [
  {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    providerName: "Anthropic",
    name: "Claude Sonnet 5.5",
    context: "200K",
    inputPrice: 3,
    outputPrice: 15,
  },
  {
    id: "gpt-x",
    provider: "openai",
    providerName: "OpenAI",
    name: "GPT X",
    context: "400K",
    inputPrice: 1,
    outputPrice: 4,
  },
];
const defaults = {
  kind: "code" as const,
  mode: "ask" as const,
  model: { provider: "anthropic", id: "claude-sonnet-5-5" },
  capMicroUsd: 2_000_000,
};

/** The section wired to storage, as ChatApp wires it. */
function Harness({ db, projectId, web }: { db: SqlDb; projectId: string; web: boolean }) {
  const [tasks, setTasks] = useState<Schedule[]>([]);
  const refresh = useCallback(async () => {
    setTasks(await listSchedules(db, t, projectId));
  }, [db, projectId]);
  useEffect(() => {
    void listSchedules(db, t, projectId).then(setTasks);
  }, [db, projectId]);
  return (
    <ScheduledTasksSection
      web={web}
      tasks={tasks}
      models={models}
      defaults={defaults}
      timeZone="Europe/London"
      onSave={async (_id, draft) => {
        try {
          await createSchedule(db, t, { ...draft, projectId });
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        await refresh();
        return null;
      }}
      onToggle={(id, on) => {
        void setScheduleEnabled(db, t, id, on).then(refresh);
      }}
      onDelete={(id) => {
        void deleteSchedule(db, t, id).then(refresh);
      }}
      onOpenChat={() => undefined}
    />
  );
}

async function setup(web = true) {
  const db = openTestDb();
  const project = await createProject(db, t, "Lighthouse");
  render(<Harness db={db} projectId={project.id} web={web} />);
  return { db, projectId: project.id, user: userEvent.setup() };
}

test("add a weekly task: the list says when, and when it runs next; it saves what was picked", async () => {
  const { db, projectId, user } = await setup();
  expect(screen.getByText(/Times are HULK's local time \(Europe\/London\)/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Add a task" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add a scheduled task" }));
  // Nothing to run yet: the server's check says why.
  await user.click(dialog.getByRole("button", { name: "Add task" }));
  expect(await dialog.findByRole("alert")).toHaveTextContent("Give the task a name.");

  await user.type(dialog.getByLabelText("Name"), "Dependency check");
  await user.type(dialog.getByLabelText("Prompt"), "Update the dependencies and run the tests.");
  await user.selectOptions(dialog.getByLabelText("What it may do"), "auto_edit");
  await user.selectOptions(dialog.getByLabelText("Model"), "openai/gpt-x");
  await user.selectOptions(dialog.getByLabelText("Repeat"), "weekly");
  await user.selectOptions(dialog.getByLabelText("Day"), "Monday");
  // jsdom types into a time box a digit at a time; a change is what a browser sends.
  fireEvent.change(dialog.getByLabelText("Time"), { target: { value: "07:30" } });
  await user.click(dialog.getByRole("button", { name: "Add task" }));

  const list = within(await screen.findByRole("list", { name: "Scheduled tasks list" }));
  expect(list.getByText("Dependency check")).toBeInTheDocument();
  expect(list.getByText("Dependency check").parentElement).toHaveTextContent(
    /Mondays at 07:30 · next Mon/,
  );
  const [saved] = await listSchedules(db, t, projectId);
  expect(saved).toMatchObject({
    name: "Dependency check",
    kind: "code",
    mode: "auto_edit",
    provider: "openai",
    model: "gpt-x",
    capMicroUsd: 2_000_000,
    repeat: "weekly",
    weekday: 1,
    minute: 7 * 60 + 30,
    enabled: true,
  });
  expect(new Date(saved?.nextAt ?? 0).getDay()).toBe(1);
});

test("the switch turns a task off, and Delete asks first", async () => {
  const { db, projectId, user } = await setup();
  await createSchedule(db, t, {
    projectId,
    name: "Nightly docs",
    prompt: "Rebuild the docs.",
    kind: "work",
    mode: "ask",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    capMicroUsd: 1_000_000,
    repeat: "daily",
    onceAt: null,
    minute: 23 * 60,
    weekday: null,
  });
  // The harness loaded before the task existed; reopening loads it.
  cleanup();
  render(<Harness db={db} projectId={projectId} web />);
  const list = within(await screen.findByRole("list", { name: "Scheduled tasks list" }));
  const row = list.getByText("Nightly docs").parentElement;
  expect(row).toHaveTextContent(/Daily at 23:00 · next/);

  await user.click(list.getByRole("checkbox", { name: "Nightly docs on" }));
  await waitFor(() => {
    expect(row).toHaveTextContent(/Daily at 23:00 · off/);
  });
  expect((await listSchedules(db, t, projectId))[0]).toMatchObject({
    enabled: false,
    nextAt: null,
  });

  await user.click(list.getByRole("button", { name: "Delete Nightly docs" }));
  const ask = within(await screen.findByRole("dialog", { name: "Delete Nightly docs?" }));
  expect(await listSchedules(db, t, projectId)).toHaveLength(1);
  await user.click(ask.getByRole("button", { name: "Delete task" }));
  await waitFor(async () => {
    expect(await listSchedules(db, t, projectId)).toHaveLength(0);
  });
  expect(await screen.findByText("No scheduled tasks yet.")).toBeInTheDocument();
});

test("a failed last run shows its note", async () => {
  const { db, projectId } = await setup();
  const s = await createSchedule(db, t, {
    projectId,
    name: "Release notes",
    prompt: "Write them.",
    kind: "code",
    mode: "plan",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    capMicroUsd: 1_000_000,
    repeat: "daily",
    onceAt: null,
    minute: 8 * 60,
    weekday: null,
  });
  await db.execute(
    "UPDATE schedules SET last_status = 'error', last_note = ?, last_at = ? WHERE id = ?",
    ["No Anthropic key yet.", Date.now(), s.id],
  );
  cleanup();
  render(<Harness db={db} projectId={projectId} web />);
  expect(await screen.findByText(/failed: No Anthropic key yet\./)).toBeInTheDocument();
});

test("on the desktop the section is greyed: scheduled tasks run in the web app", async () => {
  await setup(false);
  expect(screen.getByRole("button", { name: "Add a task" })).toBeDisabled();
  expect(
    screen.getByText("Scheduled tasks run in the web app on HULK (until sync)."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "Scheduled tasks list" })).toBeNull();
});
