/**
 * A PDF's text, page by page, read on this machine with PDF.js (FK-02): a PDF too long to send
 * whole is searched instead, with page numbers in the citations.
 */
import type * as PdfJs from "pdfjs-dist";

/** Marks where each page starts in the extracted text; chunking reads it back (chunk.ts). */
export const pageMarker = (page: number) => `--- page ${String(page)} ---`;
export const PAGE_MARKER = /^--- page (\d+) ---$/;

export interface PdfTextLimits {
  maxPages?: number;
  maxChars?: number;
}
export type PdfTextReader = (bytes: Uint8Array, limits?: PdfTextLimits) => Promise<string[]>;

/** One string per page; lines kept where the PDF ends them. */
export async function pdfTextWith(
  pdfjs: typeof PdfJs,
  bytes: Uint8Array,
  limits: PdfTextLimits = {},
): Promise<string[]> {
  // PDF.js takes ownership of the buffer it's given, so it gets a copy.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    disableFontFace: true,
  });
  const doc = await task.promise;
  try {
    if (limits.maxPages !== undefined && doc.numPages > limits.maxPages)
      throw new Error("This PDF exceeds the connector's page limit.");
    const pages: string[] = [];
    let chars = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
      }
      const remaining = Math.max(0, (limits.maxChars ?? Infinity) - chars);
      const cut = text.length > remaining;
      pages.push(
        text.slice(0, remaining).trim() +
          (cut ? "\n[PDF text limit reached; remaining content was not extracted.]" : ""),
      );
      chars += text.length;
      page.cleanup();
      if (cut) break;
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** The app's reader: PDF.js with its worker, both bundled (no network). */
export const readPdfText: PdfTextReader = async (bytes, limits) => {
  if (import.meta.env.SSR) {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ]);
    // Preload the trusted bundled parser, so HULK needs no external worker file/node_modules.
    Object.defineProperty(globalThis, "pdfjsWorker", { value: worker, configurable: true });
    return pdfTextWith(pdfjs, bytes, limits);
  }
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfTextWith(pdfjs, bytes, limits);
};

/** Pages joined with markers, for storing and chunking as text. */
export const joinPages = (pages: readonly string[]) =>
  pages.map((text, i) => `${pageMarker(i + 1)}\n${text}`).join("\n\n");
