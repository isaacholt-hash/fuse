import type { Run, RunStep } from "@/storage/runs";
import { runView, toolLabel } from "./runView";

const run: Run = {
  id: "r1",
  projectId: "p",
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
  createdAt: 1,
  updatedAt: 1,
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
  },
  {
    kind: "tool",
    id: "s3",
    seq: 3,
    call: { id: "d", name: "read_file", input: { path: "nope.ts", offset: null } },
    output: "Error: nope.ts: no such file or folder.",
    isError: true,
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
    status: "done",
    costLabel: "$0.1234 of $1.00",
    note: null,
    streaming: "",
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
