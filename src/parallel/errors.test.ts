import { parallelError } from "./useParallel";
it("keeps native string refusals actionable without inventing details from malformed errors", () => {
  expect(parallelError("Children have conflicting edits in result.txt.", "unknown")).toBe(
    "Children have conflicting edits in result.txt.",
  );
  expect(parallelError(new Error("The parent changed."), "unknown")).toBe("The parent changed.");
  expect(parallelError({ private: "untrusted body" }, "Inspect retained work.")).toBe(
    "Inspect retained work.",
  );
});
