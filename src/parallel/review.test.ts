import { expect, it } from "vitest";
import { changeSummary, shortSha } from "./review";

it("counts files and lines, a new file adding only and a deleted one removing only", () => {
  expect(
    changeSummary([
      { path: "a", before: "x\ny", after: "x\nz", mode: "100644" },
      { path: "b", before: null, after: "one\ntwo", mode: "100644" },
      { path: "c", before: "gone", after: null, mode: "100644" },
    ]),
  ).toBe("3 files, +3 −2 lines");
  expect(changeSummary([{ path: "a", before: "x", after: "y", mode: "100644" }])).toBe(
    "1 file, +1 −1 lines",
  );
});
it("a commit shows as its first 7 characters", () => {
  expect(shortSha("0123456789abcdef")).toBe("0123456");
});
