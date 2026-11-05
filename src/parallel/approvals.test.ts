import { pendingApproval } from "./approvals";
import type { ApprovalRequest } from "@/agent/run";

const question = (id: string, parentId?: string) => ({
  request: {
    runId: id,
    kind: "command",
    command: "recorded-command",
    ...(parentId ? { child: { runId: id, parentId, branch: `fuse/child/${id}` } } : {}),
  } satisfies ApprovalRequest,
  answer: vi.fn(),
});

test("a parent presents each child's original approval callback without crossing roots", () => {
  const first = question("a", "root"),
    second = question("b", "root"),
    other = question("c", "other");
  const questions = new Map([
    ["c", other],
    ["a", first],
    ["b", second],
  ]);
  expect(pendingApproval(questions, "root")).toBe(first);
  pendingApproval(questions, "root")?.answer("yes");
  expect(first.answer).toHaveBeenCalledWith("yes");
  expect(second.answer).not.toHaveBeenCalled();
  expect(other.answer).not.toHaveBeenCalled();
  questions.delete("a");
  // A stale card carries child a, so it cannot answer the now-visible sibling b.
  expect(pendingApproval(questions, "a")).toBeUndefined();
  expect(pendingApproval(questions, "root")).toBe(second);
  questions.delete("b");
  expect(pendingApproval(questions, "root")).toBeUndefined();
});

test("the parent's own exact approval takes precedence", () => {
  const root = question("root");
  const child = question("a", "root");
  expect(
    pendingApproval(
      new Map([
        ["a", child],
        ["root", root],
      ]),
      "root",
    ),
  ).toBe(root);
});
