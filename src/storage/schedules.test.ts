// @vitest-environment node
import type { startChatRun } from "@/agent/chatRun";
import type { RunDeps } from "@/agent/run";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { Runner } from "@/runner/runner";
import { DEFAULT_TENANT } from "./defaults";
import { createProject } from "./projects";
import { createRun, getRun, setRunStatus, type Run } from "./runs";
import {
  createSchedule,
  deleteSchedule,
  describeRepeat,
  dueSchedules,
  getSchedule,
  listSchedules,
  nextRun,
  setScheduleEnabled,
  type ScheduleInput,
} from "./schedules";
import type { SqlDb } from "./sql";
import { openTestDb } from "./testing/nodeDb";
import { getThread } from "./threads";

const t = DEFAULT_TENANT;
/** Local times, so the tests hold in any time zone. */
const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

describe("when a task runs next", () => {
  // Wednesday 4 Nov 2026, 10:00 local.
  const now = at(2026, 11, 4, 10);

  it("daily: later today, or tomorrow once today's time has passed", () => {
    expect(nextRun({ repeat: "daily", minute: 11 * 60, weekday: null, onceAt: null }, now)).toBe(
      at(2026, 11, 4, 11),
    );
    expect(
      nextRun({ repeat: "daily", minute: 9 * 60 + 30, weekday: null, onceAt: null }, now),
    ).toBe(at(2026, 11, 5, 9, 30));
    expect(nextRun({ repeat: "daily", minute: 10 * 60, weekday: null, onceAt: null }, now)).toBe(
      at(2026, 11, 5, 10),
    );
  });

  it("weekly: the next of its weekday, a week on if that's today and past", () => {
    const wednesday = new Date(now).getDay();
    expect(
      nextRun({ repeat: "weekly", minute: 8 * 60, weekday: wednesday, onceAt: null }, now),
    ).toBe(at(2026, 11, 11, 8));
    expect(
      nextRun({ repeat: "weekly", minute: 12 * 60, weekday: wednesday, onceAt: null }, now),
    ).toBe(at(2026, 11, 4, 12));
    expect(
      nextRun(
        { repeat: "weekly", minute: 7 * 60, weekday: (wednesday + 2) % 7, onceAt: null },
        now,
      ),
    ).toBe(at(2026, 11, 6, 7));
  });

  it("once: at its time while that's ahead, then never", () => {
    const later = at(2026, 11, 6, 14);
    expect(nextRun({ repeat: "once", minute: 0, weekday: null, onceAt: later }, now)).toBe(later);
    expect(nextRun({ repeat: "once", minute: 0, weekday: null, onceAt: now - 1 }, now)).toBeNull();
  });

  it("says when in words", () => {
    expect(
      describeRepeat({ repeat: "daily", minute: 7 * 60 + 5, weekday: null, onceAt: null }),
    ).toBe("Daily at 07:05");
    expect(describeRepeat({ repeat: "weekly", minute: 9 * 60, weekday: 1, onceAt: null })).toBe(
      "Mondays at 09:00",
    );
  });
});

const model =
  defaultCatalog.models.find((m) => m.provider === "anthropic") ?? defaultCatalog.models[0];
if (!model) throw new Error("no model in the catalog");

async function setUp(db: SqlDb, overrides: Partial<ScheduleInput> = {}, now = at(2026, 11, 4, 6)) {
  const project = await createProject(db, t, "Ops");
  const schedule = await createSchedule(
    db,
    t,
    {
      projectId: project.id,
      name: "Morning check",
      prompt: "Check the sites and log the results",
      kind: "work",
      mode: "ask",
      provider: model?.provider ?? "anthropic",
      model: model?.id ?? "",
      capMicroUsd: 500_000,
      repeat: "daily",
      onceAt: null,
      minute: 7 * 60,
      weekday: null,
      ...overrides,
    },
    now,
  );
  return { project, schedule };
}

test("tasks are saved, listed, switched off and on, and deleted", async () => {
  const db = openTestDb();
  const { project, schedule } = await setUp(db);
  expect(schedule.nextAt).toBe(at(2026, 11, 4, 7));
  expect((await listSchedules(db, t, project.id)).map((s) => s.name)).toEqual(["Morning check"]);

  await setScheduleEnabled(db, t, schedule.id, false, at(2026, 11, 4, 6));
  expect(await getSchedule(db, t, schedule.id)).toMatchObject({ enabled: false, nextAt: null });
  expect(await dueSchedules(db, t, at(2026, 11, 9, 0))).toEqual([]);
  await setScheduleEnabled(db, t, schedule.id, true, at(2026, 11, 4, 8));
  expect((await getSchedule(db, t, schedule.id))?.nextAt).toBe(at(2026, 11, 5, 7));

  await deleteSchedule(db, t, schedule.id);
  expect(await listSchedules(db, t)).toEqual([]);
  await expect(setUp(db, { name: " " })).rejects.toThrow("Give the task a name.");
});

function depsFor(db: SqlDb): () => Promise<RunDeps> {
  return () =>
    Promise.resolve({
      db,
      tenant: t,
      catalog: defaultCatalog,
      adapterFor: () => {
        throw new Error("no provider in these tests");
      },
      repo: {} as RunDeps["repo"],
    });
}

/** A run that ends as `status` with `note`. */
const endsAs =
  (status: Run["status"], note: string | null): typeof startChatRun =>
  async (deps, input) => {
    const run = await createRun(deps.db, deps.tenant, {
      projectId: input.projectId,
      threadId: input.threadId,
      messageId: null,
      task: input.task,
      provider: input.model.provider,
      model: input.model.id,
      capMicroUsd: input.capMicroUsd ?? 0,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    });
    input.onProgress?.("answer", { run, steps: [], changes: [], streaming: "" });
    await setRunStatus(deps.db, deps.tenant, run.id, status, note);
    return (await getRun(deps.db, deps.tenant, run.id)) as Run;
  };

test("on the fake clock: a due task starts a run in a new chat in its project, once", async () => {
  const db = openTestDb();
  const { project, schedule } = await setUp(db);
  let now = at(2026, 11, 4, 6, 59);
  const started: { task: string; projectId: string | null; capMicroUsd?: number; kind?: string }[] =
    [];
  const start: typeof startChatRun = async (deps, input) => {
    started.push({
      task: input.task,
      projectId: input.projectId,
      ...(input.capMicroUsd !== undefined ? { capMicroUsd: input.capMicroUsd } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
    });
    return endsAs("done", null)(deps, input);
  };
  const runner = new Runner({ deps: depsFor(db), start, now: () => now, pollMs: 1 });

  await runner.tick();
  expect(started).toEqual([]);

  now = at(2026, 11, 4, 7, 0);
  await runner.tick();
  await runner.idle();
  await runner.tick();
  expect(started).toEqual([
    {
      task: "Check the sites and log the results",
      projectId: project.id,
      capMicroUsd: 500_000,
      kind: "work",
    },
  ]);
  const after = await getSchedule(db, t, schedule.id);
  expect(after).toMatchObject({ lastStatus: "done", lastNote: null, nextAt: at(2026, 11, 5, 7) });
  const thread = await getThread(db, t, after?.lastThreadId ?? "");
  expect(thread?.title).toMatch(/^Morning check · /);
  expect(thread?.projectId).toBe(project.id);
  expect((await getRun(db, t, after?.lastRunId ?? ""))?.threadId).toBe(thread?.id);
});

test("a task whose run fails says so with the run's note; a one-off runs once", async () => {
  const db = openTestDb();
  const { schedule } = await setUp(db, { repeat: "once", onceAt: at(2026, 11, 4, 9) });
  const now = at(2026, 11, 4, 9, 1);
  const runner = new Runner({
    deps: depsFor(db),
    start: endsAs("error", "No Anthropic key yet. Add one in Settings."),
    now: () => now,
  });
  await runner.tick();
  await runner.idle();
  expect(await getSchedule(db, t, schedule.id)).toMatchObject({
    lastStatus: "error",
    lastNote: "No Anthropic key yet. Add one in Settings.",
    nextAt: null,
  });
  expect(await dueSchedules(db, t, at(2027, 1, 1, 0))).toEqual([]);
});

test("a task on a model FUSE no longer has fails with why, and the runner goes on", async () => {
  const db = openTestDb();
  const { schedule } = await setUp(db, { model: "retired-model" });
  const runner = new Runner({
    deps: depsFor(db),
    start: endsAs("done", null),
    now: () => at(2026, 11, 4, 7),
  });
  await runner.tick();
  const after = await getSchedule(db, t, schedule.id);
  expect(after?.lastStatus).toBe("error");
  expect(after?.lastNote).toContain("isn't in FUSE's list");
});
