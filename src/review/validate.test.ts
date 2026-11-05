// @vitest-environment node
import { reviewMarkdown, validateReport, validateSnapshot } from "./validate";
import { snapshot, finding } from "./testing/fixtures";
test("pins exact evidence and retains severity, side and provenance in the report", () => {
  expect(validateSnapshot(snapshot)).toEqual(snapshot);
  const report = validateReport(
    { snapshotId: snapshot.id, findings: [finding], limitations: ["No tests executed."] },
    snapshot,
  );
  const markdown = reviewMarkdown(snapshot, report);
  expect(markdown).toContain("[P1] Preserve the divisor");
  expect(markdown).toContain(finding.revision);
  expect(markdown).toContain("lines 1–1");
  expect(markdown).toContain("Consequences remain model judgments");
});
test.each([
  { path: "invented.ts" },
  { side: "old" },
  { revision: "c".repeat(40) },
  { startLine: 2, endLine: 2 },
  { quote: "return num / den;" },
  { severity: "critical" },
  { endLine: 1000 },
])("rejects a fabricated or stale finding %j", (change) => {
  expect(() =>
    validateReport(
      { snapshotId: snapshot.id, findings: [{ ...finding, ...change }], limitations: [] },
      snapshot,
    ),
  ).toThrow();
});
test("rejects the wrong snapshot and evidence on unchanged lines", () => {
  expect(() =>
    validateReport({ snapshotId: "c".repeat(64), findings: [finding], limitations: [] }, snapshot),
  ).toThrow();
  const noChanges = structuredClone(snapshot);
  noChanges.files[0]?.changedNew.splice(0);
  expect(() =>
    validateReport({ snapshotId: snapshot.id, findings: [finding], limitations: [] }, noChanges),
  ).toThrow(/unverified/);
});
test("bounded snapshots reject malicious paths, wrong ranges and hidden oversized text", () => {
  for (const path of ["../credentials", "C:/outside", "folder\\outside", ".git/config"]) {
    const copy = structuredClone(snapshot);
    const file = copy.files[0];
    if (file) file.path = path;
    expect(() => validateSnapshot(copy)).toThrow();
  }
  const copy = structuredClone(snapshot);
  const file = copy.files[0];
  if (file) file.newText = "x".repeat(65537);
  expect(() => validateSnapshot(copy)).toThrow(/limit/);
});
