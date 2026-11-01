import type { Run, RunStep } from "@/storage/runs";
import { changeView, groupBatches, runView, toolLabel } from "./runView";
import { auditCsv, auditJson } from "./runView";

const run: Run = {
  id: "r1",
  projectId: "p",
  kind: "code",
  threadId: "t",
  messageId: "m",
  task: "How high is the tide?",
  mode: "plan",
  provider: "anthropic",
  model: "x",
  status: "done",
  capMicroUsd: 1_000_000,
  spentMicroUsd: 123_400,
  note: null,
  summary: null,
  summaryUpto: null,
  branch: null,
  plan: null,
  planner: null,
  createdAt: 1,
  updatedAt: 1,
  startedAt: 1,
  waitedMs: 0,
};
const steps: RunStep[] = [
  {
    kind: "model",
    id: "s1",
    seq: 1,
    text: "1. Find the code.",
    native: null,
    requestId: null,
    costMicroUsd: 1,
  },
  {
    kind: "tool",
    id: "s2",
    seq: 2,
    call: {
      id: "c",
      name: "search_files",
      input: { query: "tide", path: null, ignore_case: false },
    },
    output: "x",
    isError: false,
    approval: "auto",
    images: [],
  },
  {
    kind: "tool",
    id: "s3",
    seq: 3,
    call: { id: "d", name: "read_file", input: { path: "nope.ts", offset: null } },
    output: "Error: nope.ts: no such file or folder.",
    isError: true,
    approval: "auto",
    images: [],
  },
  {
    kind: "model",
    id: "s4",
    seq: 4,
    text: "The tide is 3 m.",
    native: null,
    requestId: null,
    costMicroUsd: 1,
  },
];

test("steps read as plain lines; the finished run's last turn is the answer, not a step", () => {
  expect(runView(run, steps)).toEqual({
    id: "r1",
    title: "Coding run",
    status: "done",
    costLabel: "$0.1234 of $1.00",
    activeSince: null,
    note: null,
    streaming: "",
    modeLabel: "read-only",
    branch: null,
    changes: [],
    inProject: true,
    steps: [
      { id: "s1", kind: "note", label: "1. Find the code.", error: null },
      { id: "s2", kind: "tool", label: "Searched for “tide”", error: null },
      { id: "s3", kind: "tool", label: "Read nope.ts", error: "nope.ts: no such file or folder." },
    ],
  });
  // Still running or paused: every turn's note shows.
  expect(runView({ ...run, status: "paused" }, steps).steps.at(-1)?.label).toBe("The tide is 3 m.");
});

test("tool labels", () => {
  expect(toolLabel("list_files", { path: "", recursive: false })).toBe("Listed the root");
  expect(toolLabel("list_files", { path: "src", recursive: true })).toBe(
    "Listed everything under src",
  );
  expect(toolLabel("search_files", { query: "x", path: "src", ignore_case: true })).toBe(
    "Searched for “x” in src",
  );
});

test("changes: labels, diff stats and undone", () => {
  const base = {
    runId: "r1",
    stepId: null,
    createdAt: 1,
    status: "applied" as const,
    beforeSha: null,
    afterSha: null,
    batchId: null,
  };
  expect(
    changeView({
      ...base,
      id: "c1",
      path: "a.ts",
      fromPath: null,
      before: "x\ny\n",
      after: "x\nz\n",
    }),
  ).toMatchObject({
    label: "Edited a.ts",
    added: 1,
    removed: 1,
    undone: false,
  });
  expect(
    changeView({ ...base, id: "c2", path: "b.ts", fromPath: null, before: null, after: "new\n" })
      .label,
  ).toBe("Created b.ts");
  expect(
    changeView({ ...base, id: "c3", path: "c.ts", fromPath: null, before: "old\n", after: null })
      .label,
  ).toBe("Deleted c.ts");
  expect(
    changeView({
      ...base,
      id: "c4",
      path: "d/e.md",
      fromPath: "e.md",
      before: null,
      after: null,
      status: "undone",
    }),
  ).toMatchObject({
    label: "Moved e.md → d/e.md",
    lines: [],
    undone: true,
  });
});

test("WF-06: a plan's moves show as one row that lists them", () => {
  const c = (id: string, from: string, to: string, batchId: string | null) => ({
    id,
    runId: "r",
    stepId: null,
    path: to,
    fromPath: from,
    before: null,
    after: null,
    beforeSha: null,
    afterSha: null,
    batchId,
    status: "applied" as const,
    createdAt: 1,
  });
  const views = groupBatches([
    c("1", "a.jpg", "P/a.jpg", "b1"),
    c("2", "b.jpg", "P/b.jpg", "b1"),
    c("3", "x", "y", null),
  ]);
  expect(views.map((v) => v.label)).toEqual(["Organised 2 files", "Moved x → y"]);
  expect(views[0]?.id).toBe("1");
  expect(views[0]?.lines.map((l) => l.text)).toEqual(["a.jpg → P/a.jpg", "b.jpg → P/b.jpg"]);
});

test("F2: a command keeps its whole result, and its error is the output, not the command", () => {
  const output =
    "$ ping -n 1 127.0.0.1\nUnable to contact IP driver. General failure.\n[exit code 1, 0.1 s]\n[sandboxed, network off]";
  const view = runView({ ...run, projectId: null, status: "running" }, [
    {
      kind: "tool",
      id: "c1",
      seq: 1,
      call: { id: "t1", name: "run_command", input: { command: "ping -n 1 127.0.0.1" } },
      output,
      isError: true,
      approval: "you",
      images: [],
    },
  ]);
  expect(view.inProject).toBe(false);
  expect(view.steps).toEqual([
    {
      id: "c1",
      kind: "tool",
      label: "Ran ping -n 1 127.0.0.1",
      error: "Unable to contact IP driver. General failure.",
      output,
    },
  ]);
});

test("M9 step 12: the activity log exports as CSV (quoted as needed) and JSON", () => {
  const entry = {
    id: "s1",
    at: Date.UTC(2026, 9, 31, 12, 0, 0),
    project: "Notes, work",
    model: "anthropic/test",
    tool: "run_command",
    input: { command: 'echo "hi"' },
    output: "hi\nthere",
    isError: false,
    approval: "you" as const,
    runCostMicroUsd: 12_000,
    flags: [{ why: "asks to run a command", passage: "run this" }],
  };
  const csv = auditCsv([entry]);
  const [head, row] = csv.trim().split("\r\n");
  expect(head).toBe("when,project,model,tool,kind,input,allowed,failed,flagged,result,run cost");
  expect(row).toContain(
    '2026-10-31T12:00:00.000Z,"Notes, work",anthropic/test,run_command,Runs commands,',
  );
  expect(row).toContain('"{""command"":""echo \\""hi\\""""}"');
  expect(csv).toContain('"hi\nthere"');
  expect(csv).toContain("asks to run a command: run this");
  const json = JSON.parse(auditJson([entry])) as { entries: { at: string; output: string }[] };
  expect(json.entries[0]).toMatchObject({ at: "2026-10-31T12:00:00.000Z", output: "hi\nthere" });
});

test("M10 step 11: a working run counts its active time from its leg's start plus what it waited", () => {
  const working = runView({ ...run, status: "running", startedAt: 100, waitedMs: 40 }, []);
  expect(working.activeSince).toBe(140);
  expect(runView(run, []).activeSince).toBeNull();
});
