/**
 * Creating documents (M8 step 5, WF-04): Word, Excel and PDF files from structured content a
 * model writes. Word and Excel are written as minimal Office Open XML zipped with fflate, which
 * Word, Excel, LibreOffice and Google Docs open; PDF uses jsPDF (already in the app). No new
 * dependency, and nothing leaves this computer.
 */
import { strToU8, zipSync } from "fflate";

export type Block =
  | { kind: "heading"; text: string; level: number }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "numbered"; text: string }
  | { kind: "table"; rows: string[][] };

export interface SheetSpec {
  name: string;
  /** Rows of cells: "=..." is a formula, a plain number is a number, anything else is text. */
  rows: string[][];
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Characters XML 1.0 doesn't allow.
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

// ------------------------------------------------------------------ Word

const run = (text: string) =>
  text
    .split("\n")
    .map(
      (line, i) =>
        `${i > 0 ? "<w:r><w:br/></w:r>" : ""}<w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r>`,
    )
    .join("");

function wordBlock(b: Block): string {
  switch (b.kind) {
    case "heading": {
      const level = Math.min(3, Math.max(1, Math.round(b.level)));
      return `<w:p><w:pPr><w:pStyle w:val="Heading${String(level)}"/></w:pPr>${run(b.text)}</w:p>`;
    }
    case "paragraph":
      return `<w:p>${run(b.text)}</w:p>`;
    case "bullet":
    case "numbered":
      return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${b.kind === "bullet" ? "1" : "2"}"/></w:numPr></w:pPr>${run(b.text)}</w:p>`;
    case "table": {
      const width = Math.max(1, ...b.rows.map((r) => r.length));
      const border = `<w:top w:val="single" w:sz="4" w:color="999999"/><w:left w:val="single" w:sz="4" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:color="999999"/><w:right w:val="single" w:sz="4" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:color="999999"/>`;
      const rows = b.rows
        .map(
          (r, i) =>
            `<w:tr>${Array.from({ length: width }, (_, c) => {
              const t = r[c] ?? "";
              const bold = i === 0 ? "<w:rPr><w:b/></w:rPr>" : "";
              return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:r>${bold}<w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p></w:tc>`;
            }).join("")}</w:tr>`,
        )
        .join("");
      return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${border}</w:tblBorders></w:tblPr>${rows}</w:tbl><w:p/>`;
    }
  }
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

/** A .docx from a title and blocks. */
export function writeDocx(title: string | null, blocks: readonly Block[]): Uint8Array {
  const body = [
    ...(title ? [`<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${run(title)}</w:p>`] : []),
    ...blocks.map(wordBlock),
  ].join("");
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`),
    "word/styles.xml": strToU8(STYLES),
    "word/numbering.xml": strToU8(NUMBERING),
  });
}

// ------------------------------------------------------------------ Excel

const colName = (col: number): string => {
  let n = col + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function cell(ref: string, value: string, header: boolean): string {
  const style = header ? ' s="1"' : "";
  if (value.startsWith("=") && value.length > 1) {
    return `<c r="${ref}"${style}><f>${esc(value.slice(1))}</f></c>`;
  }
  if (NUMBER.test(value.trim())) return `<c r="${ref}"${style}><v>${value.trim()}</v></c>`;
  if (value === "") return "";
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

/** Sheet names Excel accepts: at most 31 characters, none of : \ / ? * [ ], unique. */
export function sheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    const base = (raw.replace(/[:\\/?*[\]]/g, " ").trim() || `Sheet${String(i + 1)}`).slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 28)} ${String(n)}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** A .xlsx from sheets; the first row of each is bold. Formulas are calculated when it opens. */
export function writeXlsx(sheets: readonly SheetSpec[]): Uint8Array {
  const list = sheets.length > 0 ? sheets : [{ name: "Sheet1", rows: [] }];
  const names = sheetNames(list.map((s) => s.name));
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${String(i + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${String(i + 1)}" r:id="rId${String(i + 1)}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((_, i) => `<Relationship Id="rId${String(i + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(i + 1)}.xml"/>`).join("")}<Relationship Id="rId${String(list.length + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
  };
  list.forEach((sheet, i) => {
    const rows = sheet.rows
      .map((r, ri) => {
        const cells = r
          .map((v, ci) => cell(`${colName(ci)}${String(ri + 1)}`, v, ri === 0))
          .join("");
        return cells ? `<row r="${String(ri + 1)}">${cells}</row>` : "";
      })
      .join("");
    files[`xl/worksheets/sheet${String(i + 1)}.xml`] =
      strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  });
  return zipSync(files);
}

// ------------------------------------------------------------------ PDF

/**
 * A PDF from a title and blocks, A4, with jsPDF's built-in Helvetica. That font covers Latin
 * scripts; other scripts come out wrong, so Word is the better choice for them.
 */
export async function writePdf(
  title: string | null,
  blocks: readonly Block[],
): Promise<Uint8Array> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margin = 56;
  const width = doc.internal.pageSize.getWidth() - margin * 2;
  const bottom = doc.internal.pageSize.getHeight() - margin;
  let y = margin;
  let numbered = 0;
  const room = (h: number) => {
    if (y + h > bottom) {
      doc.addPage();
      y = margin;
    }
  };
  const lines = (text: string, size: number, bold: boolean, indent = 0, prefix = "") => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    const wrapped = doc.splitTextToSize(text, width - indent) as string[];
    const lh = size * 1.35;
    wrapped.forEach((line, i) => {
      room(lh);
      if (i === 0 && prefix) doc.text(prefix, margin + indent - 14, y + size);
      doc.text(line, margin + indent, y + size);
      y += lh;
    });
  };
  if (title) {
    lines(title, 22, true);
    y += 8;
  }
  for (const b of blocks) {
    if (b.kind !== "numbered") numbered = 0;
    if (b.kind === "heading") {
      y += 8;
      lines(b.text, b.level <= 1 ? 16 : b.level === 2 ? 14 : 12, true);
      y += 2;
    } else if (b.kind === "paragraph") {
      lines(b.text, 11, false);
      y += 6;
    } else if (b.kind === "bullet") {
      lines(b.text, 11, false, 18, "•");
    } else if (b.kind === "numbered") {
      numbered++;
      lines(b.text, 11, false, 18, `${String(numbered)}.`);
    } else {
      const cols = Math.max(1, ...b.rows.map((r) => r.length));
      const cw = width / cols;
      doc.setFontSize(10);
      for (const [ri, r] of b.rows.entries()) {
        doc.setFont("helvetica", ri === 0 ? "bold" : "normal");
        const cells = Array.from(
          { length: cols },
          (_, c) => doc.splitTextToSize(r[c] ?? "", cw - 8) as string[],
        );
        const h = Math.max(1, ...cells.map((c) => c.length)) * 13 + 6;
        room(h);
        cells.forEach((c, ci) => {
          doc.rect(margin + ci * cw, y, cw, h);
          c.forEach((line, li) => doc.text(line, margin + ci * cw + 4, y + 13 + li * 13));
        });
        y += h;
      }
      y += 10;
    }
  }
  return new Uint8Array(doc.output("arraybuffer"));
}
