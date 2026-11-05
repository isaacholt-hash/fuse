import { historyFromSteps } from "@/agent/run";
import type { RunStep } from "@/storage/runs";
import { toolLabel } from "@/app/runView";

it("owner-approved commits remain audited data when continuing, without orphan provider tool results", () => {
  const steps: RunStep[] = ["commit_reviewed_child", "integrate_reviewed_children"].map(
    (name, seq) => ({
      id: `review-${String(seq)}`,
      seq,
      kind: "tool",
      call: {
        id: `owner-approval-${String(seq)}`,
        name,
        input: { parentRevision: "a".repeat(40) },
      },
      output: JSON.stringify({ commit: "b".repeat(40), branch: "fuse/integration/recorded" }),
      approval: "you",
      isError: false,
      images: [],
    }),
  );
  const history = historyFromSteps("Original parent", steps);
  expect(history.flatMap((m) => m.toolResults ?? [])).toEqual([]);
  expect(history).toHaveLength(3);
  expect(history[1]?.content).toContain("commit_reviewed_child");
  expect(history[2]?.content).toContain("fuse/integration/recorded");
  expect(toolLabel("integrate_reviewed_children", {})).toBe(
    "Created an approved integration branch",
  );
});
