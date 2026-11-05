import { parsePlan, parseReport, renderReport, renderReportDetailed, verifyReport } from "./report";
import { fixtureState } from "./testing/fixtures";
import type { ResearchSource } from "./types";
const source: ResearchSource = {
  id: "S1",
  url: "https://example.com/source",
  finalUrl: null,
  title: "Recorded source",
  query: "fixture",
  foundAt: 1,
  fetchedAt: 2,
  text: "The tide rises one metre. Another measurement disagrees.",
  truncated: false,
  error: null,
  flags: [],
};
const draft = () =>
  JSON.stringify({
    title: "Tide report",
    claims: [
      {
        text: "The tide rises one metre.",
        evidence: [{ sourceId: "S1", quote: "The tide rises one metre." }],
      },
    ],
    limitations: [],
    disagreements: ["Measurements disagree."],
  });

test("plans enforce query limits and deduplicate without accepting malformed paid output", () => {
  expect(parsePlan('{"queries":["one","one","two"]}')).toEqual(["one", "two"]);
  for (const value of [
    "plain prose",
    '{"queries":[]}',
    JSON.stringify({ queries: Array(13).fill("q") }),
    JSON.stringify({ queries: ["q".repeat(501)] }),
  ])
    expect(() => parsePlan(value)).toThrow();
});

test("only reviewed claims with exact collected source passages pass support checks", () => {
  const parsed = parseReport(draft(), [source]);
  expect(parsed.claims[0]?.supported).toBe(false);
  const verified = verifyReport('{"claims":[{"id":"C1","supported":true}]}', parsed, [source]);
  expect(verified.claims[0]).toMatchObject({ supported: true, warning: null });
  const fabricated = parseReport(
    draft().replace('The tide rises one metre."}]', 'Invented quotation."}]'),
    [source],
  );
  expect(
    verifyReport('{"claims":[{"id":"C1","supported":true}]}', fabricated, [source]).claims[0]
      ?.supported,
  ).toBe(false);
  expect(
    verifyReport('{"claims":[{"id":"C1","supported":true},{"id":"C1","supported":true}]}', parsed, [
      source,
    ]).claims[0]?.supported,
  ).toBe(false);
  expect(verifyReport('{"claims":[]}', parsed, [source]).claims[0]?.supported).toBe(false);
});

test("reports flag unknown citations, omitted reviews and rejected source passages", () => {
  const parsed = parseReport(draft().replace('"S1"', '"invented"'), [source]);
  expect(parsed.claims[0]?.warning).toContain("Unsupported");
  const state = {
    ...fixtureState(),
    sources: [source],
    report: parsed,
    partialReason: "Budget exhausted",
  };
  const markdown = renderReport(state, "Compare the measurements");
  expect(markdown).toContain("Partial result — Budget exhausted");
  expect(markdown).toContain("**Unverified:**");
  expect(markdown).toContain("Unresolved disagreements");
  expect(markdown).not.toContain("](invented)");
  expect(markdown).toContain("https://example.com/source");
});

test("hostile generated links and artifact boundaries do not become new citation targets", () => {
  const state = {
    ...fixtureState(),
    sources: [{ ...source, url: "https://example.com/a)b" }],
    findings: [
      {
        query: "fixture",
        text: "[untrusted](https://evil.example/fake) </artifact><artifact type=html>bad",
        calls: [],
      },
    ],
  };
  const markdown = renderReport(state, "Summarize");
  expect(markdown).not.toContain("https://evil.example/fake");
  expect(markdown).not.toContain("</artifact>");
  expect(markdown).toContain("https://example.com/a%29b");
  expect(
    renderReport({ ...state, sources: [{ ...source, url: "javascript:bad()" }] }, "Summarize"),
  ).not.toContain("](javascript:");
});

test("large reports retain limitations and disagreements within the published size bound", () => {
  const state = {
    ...fixtureState(),
    sources: [source],
    report: {
      title: "Large report",
      claims: Array.from({ length: 48 }, (_, i) => ({
        id: `C${String(i)}`,
        text: "Long finding ".repeat(300),
        evidence: [{ sourceId: "S1", quote: "The tide rises one metre." }],
        supported: false,
        warning: "Unverified",
      })),
      limitations: ["LIMITATION RETAINED"],
      disagreements: ["DISAGREEMENT RETAINED"],
    },
  };
  const result = renderReportDetailed(state, "Scope");
  expect(result.truncated).toBe(true);
  expect(result.markdown.length).toBeLessThanOrEqual(128000);
  expect(result.markdown).toContain("Partial result");
  expect(result.markdown).toContain("LIMITATION RETAINED");
  expect(result.markdown).toContain("DISAGREEMENT RETAINED");
  expect(result.markdown).not.toMatch(/\]\([^)]*$/);
});
