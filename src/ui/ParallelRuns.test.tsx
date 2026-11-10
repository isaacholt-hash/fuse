import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ParallelRuns, ParallelReviewDialog, type ParallelDialogState } from "./ParallelRuns";
import { shortBranch } from "@/parallel/branch";
import type { ParallelView } from "@/parallel/types";
afterEach(cleanup);
const view: ParallelView = {
  spentMicroUsd: 300,
  heldMicroUsd: 110,
  capMicroUsd: 5000,
  children: [
    {
      id: "child",
      task: "Fix alpha",
      status: "running",
      branch: "fuse/child/recorded",
      plan: "Inspect and test.",
      planner: "Best",
      spentMicroUsd: 200,
      note: null,
      steps: 2,
      latest: "read_file",
    },
  ],
};
const state: ParallelDialogState = {
  parentId: "parent",
  selecting: false,
  busy: false,
  attempts: [],
  result: null,
  error: null,
  snapshot: {
    id: "review-token",
    parentId: "parent",
    childId: "child",
    parentBase: { commit: "a".repeat(40), statusHash: "recorded", folderId: "parent-folder" },
    indexHash: "recorded-index",
    childHead: "a".repeat(40),
    files: [{ path: "alpha.txt", before: "old\n", after: "reviewed\n", mode: "100644" }],
    commits: [],
  },
};

it("progress has the plan, exact child Stop and combined spending while integration waits for completion", async () => {
  const onStop = vi.fn();
  render(
    <ParallelRuns
      view={view}
      parentRunning
      readOnly={false}
      onStop={onStop}
      onReview={vi.fn()}
      onIntegrate={vi.fn()}
    />,
  );
  // The children's share adds up to their rows; the run's total includes the parent's planning.
  // Money in copper; what's set aside while children work is said, the cap stays in the strip.
  expect(screen.getByText(/Tasks spent/)).toHaveTextContent(
    "Tasks spent $0.0002 of the run's $0.0003 · $0.0001 set aside for work still running",
  );
  expect(screen.getByRole("button", { name: "Review integration" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Review changes, child 1" })).toBeDisabled();
  // Branch and plan are plumbing: folded under the step count until asked for.
  expect(screen.getByText("Inspect and test.")).not.toBeVisible();
  await userEvent.click(screen.getByText("2 steps"));
  expect(screen.getByText("Plan · Best")).toBeVisible();
  expect(screen.getByText("Inspect and test.")).toBeVisible();
  expect(screen.getByText("fuse/child/recorded")).toBeVisible();
  // While a child works, the retention note says what an interruption keeps.
  expect(screen.getByText(/Continue never restarts them/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Stop child 1" }));
  expect(onStop).toHaveBeenCalledWith("child");
});
it("replicated history has no review, integration or stop authority", () => {
  render(
    <ParallelRuns
      view={view}
      parentRunning={false}
      readOnly
      onStop={vi.fn()}
      onReview={vi.fn()}
      onIntegrate={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByText(/execution owner/)).toBeVisible();
});
it("paused retained children can be reviewed after their parent pauses without replaying work", async () => {
  const onReview = vi.fn();
  render(
    <ParallelRuns
      view={{ ...view, children: view.children.map((c) => ({ ...c, status: "paused" })) }}
      parentRunning={false}
      readOnly={false}
      onReview={onReview}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Review changes, child 1" }));
  expect(onReview).toHaveBeenCalledWith("child");
  expect(screen.queryByText("Resume child")).not.toBeInTheDocument();
});
it("a displayed diff does nothing until explicit approval and Cancel never approves", async () => {
  const onApply = vi.fn(),
    onClose = vi.fn();
  render(
    <ParallelReviewDialog
      state={state}
      onApply={onApply}
      onClose={onClose}
      onPlan={vi.fn()}
      onRelease={vi.fn()}
    />,
  );
  expect(screen.getByLabelText("Reviewed child diffs")).toHaveTextContent("alpha.txt");
  expect(screen.getByText(/FUSE <fuse@local>/)).toBeVisible();
  expect(onApply).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(onApply).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Commit reviewed child" }));
  expect(onApply).toHaveBeenCalledOnce();
});
it("integration has no preselected commits and submits only the explicitly selected exact revision", async () => {
  const onPlan = vi.fn();
  render(
    <ParallelReviewDialog
      state={{
        ...state,
        selecting: true,
        snapshot: null,
        attempts: [
          {
            id: "committed",
            childId: "child",
            kind: "child",
            state: "committed",
            result: {
              commit: "b".repeat(40),
              branch: "fuse/child/recorded",
              path: "/recorded/child",
            },
          },
        ],
      }}
      onPlan={onPlan}
      onClose={vi.fn()}
      onApply={vi.fn()}
      onRelease={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Review selected commits" })).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "Review selected commits" }));
  expect(onPlan).toHaveBeenCalledWith([{ childId: "child", commit: "b".repeat(40) }]);
});
it("an interrupted attempt offers explicit claim release and keeps evidence without a commit retry", async () => {
  const onRelease = vi.fn(),
    onApply = vi.fn();
  render(
    <ParallelReviewDialog
      state={{
        ...state,
        snapshot: null,
        error: "Acknowledgement interrupted",
        attempts: [
          {
            id: "lost",
            childId: null,
            kind: "integration",
            state: "working",
            result: {
              commit: "c".repeat(40),
              branch: "fuse/integration/retained",
              path: "/recorded/retained",
            },
          },
        ],
      }}
      onRelease={onRelease}
      onApply={onApply}
      onPlan={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Acknowledgement interrupted");
  expect(
    screen.queryByRole("button", { name: "Approve integration branch" }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Keep evidence and release interrupted claim" }),
  );
  expect(onRelease).toHaveBeenCalledWith("lost");
  expect(onApply).not.toHaveBeenCalled();
});

it("a finished run leads with the outcome and one primary next step", () => {
  const done: ParallelView = {
    ...view,
    children: view.children.map((c) => ({ ...c, status: "done" as const })),
  };
  render(
    <ParallelRuns
      view={done}
      parentRunning={false}
      readOnly={false}
      onReview={vi.fn()}
      onIntegrate={vi.fn()}
    />,
  );
  expect(screen.getByRole("heading", { name: /Parallel tasks · 1/ })).toHaveTextContent(
    "1 done, edits kept apart",
  );
  const integrate = screen.getByRole("button", { name: "Review integration" });
  expect(integrate).toBeEnabled();
  expect(integrate.className).toContain("bg-primary");
  expect(screen.getByRole("button", { name: "Review changes, child 1" }).className).toContain(
    "border-border",
  );
  expect(screen.queryByText(/Continue never restarts them/)).toBeNull();
});
it("shortens a child branch's UUID and lists a numbered plan", async () => {
  expect(shortBranch("fuse/child/4b1ce1a0-b1d6-40de-b5a6-e1e2d5bd3029")).toBe(
    "fuse/child/4b1ce1a0",
  );
  const child = view.children[0];
  if (!child) throw new Error("fixture has a child");
  render(
    <ParallelRuns
      view={{
        ...view,
        children: [
          {
            ...child,
            branch: "fuse/child/4b1ce1a0-b1d6-40de-b5a6-e1e2d5bd3029",
            plan: "1. Inspect the task. 2. Write the result. 3. Check the worktree.",
          },
        ],
      }}
      readOnly={false}
      parentRunning={false}
    />,
  );
  await userEvent.click(screen.getByText("2 steps"));
  expect(screen.getByText("fuse/child/4b1ce1a0")).toBeVisible();
  const items = screen.getAllByRole("listitem").map((li) => li.textContent);
  expect(items).toEqual(
    expect.arrayContaining(["Inspect the task.", "Write the result.", "Check the worktree."]),
  );
});
