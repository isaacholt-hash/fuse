// @vitest-environment node
import { jsPDF } from "jspdf";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { chunkText } from "@/knowledge/chunk";
import { joinPages, pdfTextWith } from "./pdfText";

test("a real PDF's text comes out page by page, and chunks cite their page", async () => {
  const doc = new jsPDF();
  doc.text("The boiler service is due in March.", 10, 10);
  doc.addPage();
  doc.text("Warranty: five years on parts.", 10, 10);
  doc.addPage();
  doc.text("Call 0113 496 0000 for repairs.", 10, 10);
  const bytes = new Uint8Array(doc.output("arraybuffer"));

  const pages = await pdfTextWith(pdfjs, bytes);
  expect(pages).toEqual([
    "The boiler service is due in March.",
    "Warranty: five years on parts.",
    "Call 0113 496 0000 for repairs.",
  ]);
  const chunks = chunkText(joinPages(pages), 12);
  expect(chunks.find((c) => c.text.includes("Warranty"))).toMatchObject({
    page: 2,
    lineStart: null,
  });
  expect(chunks.find((c) => c.text.includes("repairs"))?.page).toBe(3);
});
