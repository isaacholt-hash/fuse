/**
 * Exports (AR-04): an artifact saved as its natural file, and Markdown also as .docx or .pdf.
 * Conversions run here; the save dialog and the write happen in Rust (src-tauri/src/export.rs).
 */
import { invoke } from "@/platform/core";
import { strToU8, zipSync } from "fflate";
import type { ArtifactType } from "./parse";

export interface ExportApi {
  /** Shows "Save as…" and writes the bytes; the saved file's name, or null when cancelled. */
  save(name: string, bytes: Uint8Array): Promise<string | null>;
}

export const tauriExportApi: ExportApi = {
  save: (name, bytes) =>
    invoke<string | null>("save_as", bytes, { headers: { "x-file-name": name } }),
};

/**
 * The web app on HULK (M10 step 5): no save dialog in a browser, so the file is a download,
 * saved wherever the browser saves them.
 */
export const browserExportApi: ExportApi = {
  save: (name, bytes) => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    // The browser has the file once the click is handled; the URL can go a little later.
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 60_000);
    return Promise.resolve(name);
  },
};

const CODE_EXT: Record<string, string> = {
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  javascript: "js",
  js: "js",
  jsx: "jsx",
  python: "py",
  py: "py",
  rust: "rs",
  rs: "rs",
  go: "go",
  java: "java",
  kotlin: "kt",
  csharp: "cs",
  cs: "cs",
  cpp: "cpp",
  c: "c",
  ruby: "rb",
  php: "php",
  bash: "sh",
  sh: "sh",
  shell: "sh",
  powershell: "ps1",
  sql: "sql",
  json: "json",
  yaml: "yaml",
  yml: "yml",
  toml: "toml",
  html: "html",
  css: "css",
  swift: "swift",
  markdown: "md",
};

/** The natural extension for an artifact. */
export function extensionFor(type: ArtifactType, language: string): string {
  switch (type) {
    case "markdown":
      return "md";
    case "html":
      return "html";
    case "svg":
      return "svg";
    case "mermaid":
      return "mmd";
    case "react":
      return "tsx";
    case "code":
      return (
        CODE_EXT[language.toLowerCase()] ?? (/^[a-z0-9]{1,5}$/i.test(language) ? language : "txt")
      );
  }
}

/** "Lisbon trip" + "md" → "Lisbon trip.md" (keeps a title that already ends in the extension). */
export function fileName(title: string, ext: string): string {
  const base = title.trim() || "artifact";
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** **bold**, *italic*, `code` as Word runs. */
function runs(text: string): string {
  const out: string[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(run(text.slice(last, m.index)));
    const t = m[0];
    out.push(
      t.startsWith("**")
        ? run(t.slice(2, -2), "<w:b/>")
        : t.startsWith("`")
          ? run(t.slice(1, -1), '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>')
          : run(t.slice(1, -1), "<w:i/>"),
    );
    last = m.index + t.length;
  }
  if (last < text.length) out.push(run(text.slice(last)));
  return out.join("");
}
const run = (text: string, props = "") =>
  `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
const para = (body: string, style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${body}</w:p>`;

/** Markdown as a .docx: headings, paragraphs, lists, quotes, code blocks and inline styles. */
export function markdownToDocx(markdown: string): Uint8Array {
  const body: string[] = [];
  let code: string[] | null = null;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim().startsWith("```")) {
      if (code) {
        for (const l of code)
          body.push(
            para(run(l || " ", '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>'), "Code"),
          );
        code = null;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (heading)
      body.push(para(runs(heading[2] ?? ""), `Heading${String(heading[1]?.length ?? 1)}`));
    else if (bullet) body.push(para(runs(`• ${bullet[1] ?? ""}`), "ListParagraph"));
    else if (numbered)
      body.push(para(runs(`${numbered[1] ?? ""}. ${numbered[2] ?? ""}`), "ListParagraph"));
    else if (quote) body.push(para(runs(quote[1] ?? ""), "Quote"));
    else if (line.trim()) body.push(para(runs(line)));
  }
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const style = (id: string, name: string, rpr: string, ppr = "") =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}<w:rPr>${rpr}</w:rPr></w:style>`;
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/_rels/document.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ),
    "word/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:sz w:val="22"/></w:rPr></w:style>${style("Heading1", "heading 1", '<w:b/><w:sz w:val="36"/>', '<w:spacing w:before="240"/>')}${style("Heading2", "heading 2", '<w:b/><w:sz w:val="30"/>', '<w:spacing w:before="200"/>')}${style("Heading3", "heading 3", '<w:b/><w:sz w:val="26"/>')}${style("ListParagraph", "List Paragraph", "", '<w:ind w:left="360"/>')}${style("Quote", "Quote", '<w:i/><w:color w:val="555555"/>', '<w:ind w:left="360"/>')}${style("Code", "Code", '<w:sz w:val="19"/>', '<w:spacing w:after="0"/>')}</w:styles>`,
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
    ),
  });
}

/** Markdown as a .pdf (A4): headings, wrapped paragraphs, lists and monospaced code. */
export async function markdownToPdf(markdown: string, title: string): Promise<Uint8Array> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.setProperties({ title });
  const margin = 56;
  const width = doc.internal.pageSize.getWidth() - margin * 2;
  const bottom = doc.internal.pageSize.getHeight() - margin;
  let y = margin;
  const write = (
    text: string,
    size: number,
    font: "helvetica" | "courier",
    style = "normal",
    indent = 0,
  ) => {
    doc.setFont(font, style);
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(text, width - indent) as string[];
    for (const l of lines) {
      if (y + size > bottom) {
        doc.addPage();
        y = margin;
      }
      doc.text(l, margin + indent, y + size);
      y += size * 1.35;
    }
  };
  const plain = (s: string) =>
    s
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
  let code = false;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim().startsWith("```")) {
      code = !code;
      y += 4;
      continue;
    }
    if (code) {
      write(line || " ", 9, "courier");
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (heading) {
      y += 6;
      write(
        plain(heading[2] ?? ""),
        [18, 15, 13][(heading[1]?.length ?? 1) - 1] ?? 13,
        "helvetica",
        "bold",
      );
    } else if (bullet) {
      write(`•  ${plain(bullet[1] ?? "")}`, 11, "helvetica", "normal", 12);
    } else if (line.trim()) {
      write(plain(line), 11, "helvetica");
    } else {
      y += 6;
    }
  }
  return new Uint8Array(doc.output("arraybuffer"));
}
