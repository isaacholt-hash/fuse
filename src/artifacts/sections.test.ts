import { locateAnchor, markdownSections, rangeForSelection, textAnchor } from "./sections";

test("sections split on ATX and setext headings, never inside code fences", () => {
  const doc = "Intro text.\n\n# One\n\nBody.\n\n```md\n# Not a heading\n```\n\nTwo\n---\n\nEnd.\n";
  const sections = markdownSections(doc);
  expect(sections.map((s) => [s.title, s.level])).toEqual([
    ["Introduction", 0],
    ["One", 1],
    ["Two", 2],
  ]);
  // Sections cover the whole document without gaps.
  expect(sections[0]?.start).toBe(0);
  expect(sections.at(-1)?.end).toBe(doc.length);
  for (let i = 1; i < sections.length; i++) expect(sections[i]?.start).toBe(sections[i - 1]?.end);
  expect(doc.slice(sections[2]?.start, sections[2]?.end)).toBe("Two\n---\n\nEnd.\n");
  expect(markdownSections("No headings here.")).toEqual([
    { title: "Whole document", start: 0, end: 17, level: 0 },
  ]);
});

test("anchors are exact on their version and only offered for review when unique elsewhere", () => {
  const v1 = "Alpha beta gamma.";
  const anchor = textAnchor("v1", v1, 6, 10);
  expect(anchor.quote).toBe("beta");
  expect(locateAnchor(anchor, "v1", v1)).toEqual({ kind: "exact", start: 6, end: 10 });
  expect(locateAnchor(anchor, "v2", "Now: Alpha beta gamma.")).toEqual({
    kind: "review",
    start: 11,
    end: 15,
  });
  expect(locateAnchor(anchor, "v2", "beta and beta")).toMatchObject({ kind: "missing" });
  expect(locateAnchor(anchor, "v2", "gone")).toMatchObject({ kind: "missing" });
  expect(() => textAnchor("v1", v1, 3, 3)).toThrow("Select between");
  expect(() => textAnchor("v1", v1, 0, 99)).toThrow("Select between");
});

test("a rendered selection maps to the source only when it appears once", () => {
  expect(rangeForSelection("One two three", " two ")).toEqual({
    start: 4,
    end: 7,
    quote: "two",
    title: "",
  });
  expect(rangeForSelection("two and two", "two")).toBeNull();
  expect(rangeForSelection("**bold** text", "bold text")).toBeNull();
  expect(rangeForSelection("anything", "   ")).toBeNull();
});
