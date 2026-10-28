// @vitest-environment node
import type { Message } from "./messages";
import { branchesOf, buildPath, leafUnder } from "./tree";
import { EMPTY_USAGE } from "./usage";

let clock = 0;
const m = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  extra: Partial<Message> = {},
): Message => ({
  id,
  threadId: "t",
  parentId,
  role,
  content: id,
  status: "complete",
  errorCode: null,
  errorMessage: null,
  provider: null,
  model: null,
  usage: EMPTY_USAGE,
  requestId: null,
  route: null,
  bestCostMicroUsd: null,
  escalatedFromId: null,
  feedback: null,
  createdAt: ++clock,
  updatedAt: clock,
  ...extra,
});

// q1 → a1 → q2 → a2, then q2 edited (q2b → a2b), and a1 regenerated (a1b).
const q1 = m("q1", null, "user");
const a1 = m("a1", "q1", "assistant");
const q2 = m("q2", "a1", "user");
const a2 = m("a2", "q2", "assistant");
const q2b = m("q2b", "a1", "user");
const a2b = m("a2b", "q2b", "assistant");
const a1b = m("a1b", "q1", "assistant");
const all = [q1, a1, q2, a2, q2b, a2b, a1b];
const ids = (list: Message[]) => list.map((x) => x.id);

test("the path runs root to the active leaf; with none, to the newest leaf", () => {
  expect(ids(buildPath(all, "a2"))).toEqual(["q1", "a1", "q2", "a2"]);
  expect(ids(buildPath(all, "a2b"))).toEqual(["q1", "a1", "q2b", "a2b"]);
  expect(ids(buildPath(all, null))).toEqual(["q1", "a1b"]);
  expect(ids(buildPath(all, "deleted"))).toEqual(["q1", "a1b"]);
  expect(buildPath([], null)).toEqual([]);
});

test("siblings: position and total for each message on the path that has them", () => {
  const branches = branchesOf(all, buildPath(all, "a2b"));
  expect(branches.get("a1")).toEqual({ position: 1, total: 2, siblings: ["a1", "a1b"] });
  expect(branches.get("q2b")).toEqual({ position: 2, total: 2, siblings: ["q2", "q2b"] });
  expect(branches.has("q1")).toBe(false);
});

test("switching to a sibling shows its newest path", () => {
  expect(leafUnder(all, "a1")).toBe("a2b");
  expect(leafUnder(all, "q2")).toBe("a2");
  expect(leafUnder(all, "a1b")).toBe("a1b");
});

test("a stronger re-run sits beside its original on the path, and isn't a branch", () => {
  const b = m("b", "q1", "assistant", { escalatedFromId: "a1b" });
  const q3 = m("q3", "b", "user");
  const tree = [...all, b, q3];
  expect(ids(buildPath(tree, "q3"))).toEqual(["q1", "a1b", "b", "q3"]);
  expect(leafUnder(tree, "a1b")).toBe("q3");
  expect(branchesOf(tree, buildPath(tree, "q3")).get("a1b")?.total).toBe(2);
});
