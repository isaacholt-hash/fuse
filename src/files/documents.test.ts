import { strToU8, zipSync } from "fflate";
import { docxText, documentKind, pdfPageCount, prepareDocument, textTokens } from "./documents";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (body: string) =>
  zipSync({
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    ),
  });
const pdf = (pages: number) =>
  strToU8(
    `%PDF-1.7\n1 0 obj << /Type /Pages /Count ${String(pages)} >> endobj\n` +
      Array.from(
        { length: pages },
        (_, i) => `${String(i + 2)} 0 obj << /Type /Page >> endobj\n`,
      ).join(""),
  );

test("file kinds by extension or type", () => {
  expect(documentKind("report.PDF", "")).toBe("pdf");
  expect(documentKind("brief.docx", "")).toBe("docx");
  expect(documentKind("main.rs", "")).toBe("text");
  expect(documentKind("data", "application/json")).toBe("text");
  expect(documentKind("slides.pptx", "")).toBeNull();
  expect(documentKind("photo.heic", "image/heic")).toBeNull();
});

test("Word: paragraph text, tabs and line breaks, no formatting", () => {
  const bytes = docx(
    '<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p>' +
      "<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>",
  );
  expect(docxText(bytes)).toBe("Hello world\na\tb\nc");
  expect(() => docxText(strToU8("not a zip"))).toThrow(/couldn't be opened/);
});

test("PDF pages are counted from page objects, not the page tree", () => {
  expect(pdfPageCount(pdf(3))).toBe(3);
});

test("prepareDocument: PDFs stay PDFs, everything else becomes text with an estimate", async () => {
  const p = await prepareDocument(new File([pdf(2)], "a.pdf", { type: "application/pdf" }));
  expect(p).toMatchObject({ kind: "pdf", mime: "application/pdf", pages: 2, tokens: 6000 });

  const w = await prepareDocument(
    new File([docx("<w:p><w:r><w:t>Hi there</w:t></w:r></w:p>")], "b.docx"),
  );
  expect(w).toMatchObject({ kind: "text", mime: "text/plain", tokens: textTokens("Hi there") });
  expect(new TextDecoder().decode(w.bytes)).toBe("Hi there");
});

test("a PDF over 100 pages becomes its text with page markers, searched by default", async () => {
  const pages = Array.from({ length: 101 }, (_, i) => `Text of page ${String(i + 1)}`);
  const p = await prepareDocument(new File([pdf(101)], "manual.pdf"), {
    readPdf: () => Promise.resolve(pages),
  });
  expect(p).toMatchObject({ kind: "text", mime: "text/plain", pages: 101, searchOnly: true });
  expect(new TextDecoder().decode(p.bytes)).toMatch(
    /^--- page 1 ---\nText of page 1\n\n--- page 2 ---\nText of page 2/,
  );
  // Project knowledge searches every PDF, small ones too.
  const small = await prepareDocument(new File([pdf(2)], "a.pdf"), {
    readPdf: () => Promise.resolve(["One", "Two"]),
    searchPdf: true,
  });
  expect(small).toMatchObject({ kind: "text", pages: 2 });
});

test("refusals are plain English", async () => {
  // Past 100 pages a PDF is searched instead (FK-02); a PDF with no text can't be.
  await expect(
    prepareDocument(new File([pdf(101)], "scan.pdf"), { readPdf: () => Promise.resolve(["", ""]) }),
  ).rejects.toThrow(/no text to search/);
  await expect(
    prepareDocument(new File([new Uint8Array([0xff, 0xfe, 0x00])], "x.txt")),
  ).rejects.toThrow(/isn't plain text/);
  await expect(prepareDocument(new File(["   "], "empty.md"))).rejects.toThrow(/no text/);
  // Past the whole-file limit a text file is still taken: it's searched instead (FK-03).
  await expect(prepareDocument(new File(["x".repeat(800_004)], "big.txt"))).resolves.toMatchObject({
    tokens: 200_001,
  });
  await expect(prepareDocument(new File(["x".repeat(20_000_004)], "huge.txt"))).rejects.toThrow(
    /Too long even to search/,
  );
  await expect(prepareDocument(new File(["x"], "deck.pptx"))).rejects.toThrow(/Unsupported/);
});
