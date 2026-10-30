// @vitest-environment node
import { strToU8, zipSync } from "fflate";
import {
  cellRef,
  colName,
  docKind,
  docxText,
  partOf,
  xlsxSheets,
  xlsxText,
  MAX_DOC_CHARS,
} from "./read";

const DOCX = zipSync({
  "word/document.xml": strToU8(`<?xml version="1.0"?>
<w:document xmlns:w="x"><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Tide report</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Summary</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">High tide at </w:t></w:r><w:r><w:t>06:12 &amp; 18:40.</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Bring boots</w:t></w:r></w:p>
<w:p/>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Day</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Height</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Mon</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3.1 m</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`),
});

const XLSX = zipSync({
  "xl/workbook.xml": strToU8(
    `<workbook><sheets><sheet name="Tides" sheetId="1" r:id="rId1"/><sheet name="Empty &amp; spare" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  ),
  "xl/_rels/workbook.xml.rels": strToU8(
    `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
  ),
  "xl/sharedStrings.xml": strToU8(
    `<sst><si><t>Day</t></si><si><t>Height</t></si><si><r><t>Mo</t></r><r><t>n</t></r></si></sst>`,
  ),
  "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>3.1</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>Total</t></is></c><c r="B3"><f>SUM(B2:B2)</f><v>3.1</v></c><c r="C3" t="b"><v>1</v></c></row>
</sheetData></worksheet>`),
  "xl/worksheets/sheet2.xml": strToU8(`<worksheet><sheetData/></worksheet>`),
});

test("Word: headings, paragraphs, list items and tables as text", () => {
  expect(docxText(DOCX)).toBe(
    [
      "# Tide report",
      "## Summary",
      "High tide at 06:12 & 18:40.",
      "- Bring boots",
      "| Day | Height |\n| --- | --- |\n| Mon | 3.1 m |",
    ].join("\n\n"),
  );
  expect(() => docxText(strToU8("not a zip"))).toThrow(/isn't a zip/);
  expect(() => docxText(XLSX)).toThrow(/isn't a Word document/);
});

test("Excel: every sheet with cell references, values and formulas; a range on request", () => {
  const sheets = xlsxSheets(XLSX);
  expect(sheets.map((s) => [s.name, s.dimension])).toEqual([
    ["Tides", "A1:C3"],
    ["Empty & spare", null],
  ]);
  const all = xlsxText(XLSX);
  expect(all).toContain("Sheets: Tides (A1:C3), Empty & spare (empty)");
  expect(all).toContain("| 2 | Mon | 3.1 |  |");
  expect(all).toContain("| 3 | Total | 3.1 (=SUM(B2:B2)) | TRUE |");
  expect(xlsxText(XLSX, "tides", "B1:B2")).toContain("| 1 | Height |");
  expect(xlsxText(XLSX, "tides", "B1:B2")).not.toContain("Total");
  expect(() => xlsxText(XLSX, "Nope")).toThrow(/the sheets are: Tides, Empty & spare/);
});

test("cell references and column names round-trip", () => {
  expect(cellRef("A1")).toEqual({ col: 0, row: 1 });
  expect(cellRef("AB12")).toEqual({ col: 27, row: 12 });
  expect(colName(27)).toBe("AB");
  expect(colName(0)).toBe("A");
  expect(cellRef("1A")).toBeNull();
});

test("document kinds by extension, and long text in parts", () => {
  expect(["a.docx", "b.XLSX", "c.pdf", "d.png", "e.md"].map(docKind)).toEqual([
    "word",
    "excel",
    "pdf",
    "image",
    "other",
  ]);
  const long = "x".repeat(MAX_DOC_CHARS + 10);
  expect(partOf(long, 0)).toMatch(/10 more characters; read again with offset 40000/);
  expect(partOf(long, MAX_DOC_CHARS)).toBe("x".repeat(10));
});
