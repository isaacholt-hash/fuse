// @vitest-environment node
import { docxText, xlsxSheets, xlsxText } from "./read";
import { sheetNames, writeDocx, writePdf, writeXlsx } from "./write";

test("Word: what's written reads back as the same headings, items and tables", () => {
  const bytes = writeDocx("Tide report", [
    { kind: "heading", text: "Summary", level: 2 },
    { kind: "paragraph", text: "High tide at 06:12 & 18:40 <today>." },
    { kind: "bullet", text: "Bring boots" },
    { kind: "numbered", text: "Check the forecast" },
    {
      kind: "table",
      rows: [
        ["Day", "Height"],
        ["Mon", "3.1 m"],
      ],
    },
  ]);
  expect(docxText(bytes)).toBe(
    [
      "# Tide report",
      "## Summary",
      "High tide at 06:12 & 18:40 <today>.",
      "- Bring boots",
      "- Check the forecast",
      "| Day | Height |\n| --- | --- |\n| Mon | 3.1 m |",
    ].join("\n\n"),
  );
});

test("Excel: text, numbers and formulas per sheet; names made valid and unique", () => {
  const bytes = writeXlsx([
    {
      name: "Tides",
      rows: [
        ["Day", "Height"],
        ["Mon", "3.1"],
        ["Tue", "2.9"],
        ["Total", "=SUM(B2:B3)"],
      ],
    },
    { name: "Tides", rows: [] },
    { name: "a/b:c?", rows: [["x"]] },
  ]);
  const sheets = xlsxSheets(bytes);
  expect(sheets.map((s) => s.name)).toEqual(["Tides", "Tides 2", "a b c"]);
  expect(sheets[0]?.cells.get("B2")).toEqual({ value: "3.1", formula: null });
  expect(sheets[0]?.cells.get("B4")).toEqual({ value: "", formula: "=SUM(B2:B3)" });
  expect(xlsxText(bytes)).toContain("| 1 | Day | Height |");
  expect(sheetNames(["x".repeat(40)])[0]).toHaveLength(31);
});

test("PDF: a real PDF file", async () => {
  const bytes = await writePdf("Report", [
    { kind: "heading", text: "Part one", level: 1 },
    { kind: "paragraph", text: "Some words ".repeat(200) },
    {
      kind: "table",
      rows: [
        ["A", "B"],
        ["1", "2"],
      ],
    },
  ]);
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(1000);
});
