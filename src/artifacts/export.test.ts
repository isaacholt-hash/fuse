// @vitest-environment node
import { strFromU8, unzipSync } from "fflate";
import { extensionFor, fileName, markdownToDocx, markdownToPdf } from "./export";

test("natural extensions and file names", () => {
  expect(extensionFor("markdown", "")).toBe("md");
  expect(extensionFor("code", "Python")).toBe("py");
  expect(extensionFor("code", "zig")).toBe("zig");
  expect(extensionFor("code", "weird lang!")).toBe("txt");
  expect(extensionFor("mermaid", "")).toBe("mmd");
  expect(fileName("Lisbon trip", "md")).toBe("Lisbon trip.md");
  expect(fileName("fetch.py", "py")).toBe("fetch.py");
});

test("a .docx with headings, bullets, code and escaped text", () => {
  const files = unzipSync(
    markdownToDocx("# Plan\n\nSome **bold** & <odd> text.\n\n- one\n- two\n\n```\nlet x = 1;\n```"),
  );
  expect(Object.keys(files).sort()).toEqual([
    "[Content_Types].xml",
    "_rels/.rels",
    "word/_rels/document.xml.rels",
    "word/document.xml",
    "word/styles.xml",
  ]);
  const doc = strFromU8(files["word/document.xml"] ?? new Uint8Array());
  expect(doc).toContain(
    '<w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">Plan</w:t>',
  );
  expect(doc).toContain('<w:b/></w:rPr><w:t xml:space="preserve">bold</w:t>');
  expect(doc).toContain("&amp; &lt;odd&gt; text.");
  expect(doc).toContain("• one");
  expect(doc).toContain("let x = 1;");
});

test("a .pdf comes out as a PDF", async () => {
  const pdf = await markdownToPdf("# Plan\n\nA paragraph.\n\n- item", "Plan");
  expect(strFromU8(pdf.slice(0, 5))).toBe("%PDF-");
  expect(pdf.length).toBeGreaterThan(500);
});
