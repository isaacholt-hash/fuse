// Document attachments (M1 step 3, docs/providers.md M1): PDFs go to the provider natively;
// everything else is turned into text on this machine, so the same history works on either
// provider after a model switch.
import { strFromU8, unzipSync } from "fflate";

/** Whole-file only in M1 (retrieval over large files is M2). */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 100;
export const MAX_TEXT_TOKENS = 200_000;
/** Above this, the chip warns that the file is expensive to keep in a thread. */
export const LARGE_TEXT_TOKENS = 20_000;

const TEXT_EXTENSIONS = new Set(
  (
    "txt md markdown csv tsv json jsonl xml html htm css scss js jsx mjs cjs ts tsx py rs go java kt " +
    "c h cc cpp hpp cs rb php sh bash zsh ps1 sql yaml yml toml ini cfg conf env log tex rst svelte vue"
  ).split(" "),
);

export const DOCUMENT_ACCEPT = ".pdf,.docx," + [...TEXT_EXTENSIONS].map((e) => `.${e}`).join(",");

const extension = (name: string) => name.toLowerCase().split(".").pop() ?? "";

export type DocumentKind = "pdf" | "docx" | "text";

export function documentKind(name: string, mime: string): DocumentKind | null {
  const ext = extension(name);
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (TEXT_EXTENSIONS.has(ext) || mime.startsWith("text/") || mime === "application/json") {
    return "text";
  }
  return null;
}

/** Rough count for plain text (≈4 characters per token for English and code). */
export const textTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * PDF tokens per page, for the estimate only: both providers send each page's text (≈1.5–3k
 * tokens per page) plus the page as an image. The bill comes from usage.
 */
export const PDF_TOKENS_PER_PAGE = 3000;

/** Counts pages from the PDF's page objects; good enough for an estimate and the page cap. */
export function pdfPageCount(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  const pages = text.match(/\/Type\s*\/Page(?!s)\b/g);
  return pages?.length ?? 0;
}

/** Text from a .docx (the paragraphs of word/document.xml), without formatting. */
export function docxText(bytes: Uint8Array): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
  } catch {
    throw new Error("This Word file couldn't be opened.");
  }
  const xml = files["word/document.xml"];
  if (!xml) throw new Error("This Word file has no document text.");
  const doc = new DOMParser().parseFromString(strFromU8(xml), "application/xml");
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const paragraphs = Array.from(doc.getElementsByTagNameNS(W, "p"), (p) => {
    let line = "";
    for (const node of Array.from(p.getElementsByTagNameNS(W, "*"))) {
      if (node.localName === "t") line += node.textContent;
      else if (node.localName === "tab") line += "\t";
      else if (node.localName === "br") line += "\n";
    }
    return line;
  });
  return paragraphs
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Strict UTF-8 decode: binary files are refused rather than sent as garbage. */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("This file isn't plain text (UTF-8).");
  }
}

export interface PreparedDocument {
  kind: "pdf" | "text";
  /** What's stored and sent: the PDF itself, or the UTF-8 text. */
  bytes: Uint8Array;
  mime: "application/pdf" | "text/plain";
  tokens: number;
  pages: number | null;
}

/** Checks a document and turns it into what's stored and sent. Throws a plain-English error. */
export async function prepareDocument(file: File): Promise<PreparedDocument> {
  const kind = documentKind(file.name, file.type);
  if (!kind) {
    throw new Error("Unsupported file. Images, PDF, Word (.docx), text, CSV and code work.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (kind === "pdf") {
    if (bytes.length > MAX_PDF_BYTES) throw new Error("PDFs over 20 MB aren't supported yet.");
    const pages = pdfPageCount(bytes);
    if (pages > MAX_PDF_PAGES) {
      throw new Error(
        `PDFs over ${String(MAX_PDF_PAGES)} pages aren't supported yet (${String(pages)} pages).`,
      );
    }
    return {
      kind,
      bytes,
      mime: "application/pdf",
      tokens: Math.max(1, pages) * PDF_TOKENS_PER_PAGE,
      pages,
    };
  }
  const text = kind === "docx" ? docxText(bytes) : decodeText(bytes);
  if (!text.trim()) throw new Error("This file has no text.");
  const tokens = textTokens(text);
  if (tokens > MAX_TEXT_TOKENS) {
    throw new Error(
      `Too long to send whole (~${tokens.toLocaleString("en-US")} tokens). Search inside large files comes later.`,
    );
  }
  return {
    kind: "text",
    bytes: new TextEncoder().encode(text),
    mime: "text/plain",
    tokens,
    pages: null,
  };
}
