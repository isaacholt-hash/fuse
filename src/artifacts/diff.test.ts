// @vitest-environment node
import { diffLines, diffStats } from "./diff";

test("unchanged, added and removed lines, in order", () => {
  const d = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
  expect(d).toEqual([
    { kind: "same", text: "a" },
    { kind: "del", text: "b" },
    { kind: "add", text: "B" },
    { kind: "same", text: "c" },
    { kind: "same", text: "d" },
    { kind: "add", text: "e" },
  ]);
  expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
  expect(diffLines("same", "same")).toEqual([{ kind: "same", text: "same" }]);
});
