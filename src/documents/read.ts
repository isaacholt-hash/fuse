/**
 * Reading documents in a folder (M8 step 4, WF-03): Word and Excel files are zip archives of XML,
 * read here with fflate and a small XML reader (no new dependency); PDFs use the existing PDF.js
 * reader. What comes back is plain text a model can read: Word as Markdown-like text with
 * headings, lists and tables; Excel as one table per sheet with cell references. Everything runs
 * on this computer.
 */
import { unzipSync } from "fflate";

export const MAX_DOC_CHARS = 40_000;
const MAX_ROWS = 200;
const MAX_COLS = 30;

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

function entries(bytes: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes);
  } catch {
    throw new Error("This doesn't look like a valid Word or Excel file (it isn't a zip archive).");
  }
}

const text = (files: Record<string, Uint8Array>, name: string) => {
  const f = files[name];
  return f ? new TextDecoder().decode(f) : null;
};

/** Every match of an element's content, `<tag ...>…</tag>`, non-nested (enough for these parts). */
function all(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1] ?? "");
  return out;
}

const attr = (tagText: string, name: string) =>
  new RegExp(`${name}="([^"]*)"`).exec(tagText)?.[1] ?? null;

// ------------------------------------------------------------------ Word

/** A paragraph's text: its runs' text, tabs and breaks. */
function paragraphText(p: string): string {
  let out = "";
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g;
  for (let m = re.exec(p); m; m = re.exec(p)) {
    if (m[1] !== undefined) out += decode(m[1]);
    else out += m[0].startsWith("<w:tab") ? "\t" : "\n";
  }
  return out;
}

function paragraph(p: string): string {
  const t = paragraphText(p).trim();
  if (!t) return "";
  const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? "";
  const heading = /^(?:Heading|heading)\s?(\d)$/.exec(style)?.[1];
  if (heading) return `${"#".repeat(Math.min(6, Number(heading)))} ${t}`;
  if (style === "Title") return `# ${t}`;
  if (p.includes("<w:numPr>")) return `- ${t}`;
  return t;
}

function table(tbl: string): string {
  const rows = all(tbl, "w:tr").map((tr) =>
    all(tr, "w:tc").map((tc) =>
      all(tc, "w:p").map(paragraphText).join(" ").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim(),
    ),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0] ?? []), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

/** A Word document as text: headings as #, list items as -, tables as Markdown tables. */
export function docxText(bytes: Uint8Array): string {
  const files = entries(bytes);
  const doc = text(files, "word/document.xml");
  if (doc === null) throw new Error("This isn't a Word document (no word/document.xml inside).");
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(doc)?.[1] ?? doc;
  const blocks: string[] = [];
  // Top-level paragraphs and tables, in order.
  const re = /<w:tbl>([\s\S]*?)<\/w:tbl>|<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p(?:\s[^>]*)?\/>/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const block = m[1] !== undefined ? table(m[1]) : m[2] !== undefined ? paragraph(m[2]) : "";
    if (block) blocks.push(block);
  }
  return blocks.join("\n\n");
}

// ------------------------------------------------------------------ Excel

/** "AB12" → column 27 (0-based 27), row 12. */
export function cellRef(ref: string): { col: number; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
  if (!m?.[1] || !m[2]) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) };
}

export const colName = (col: number): string => {
  let n = col + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

export interface Sheet {
  name: string;
  /** Cells by "A1" reference: the value as text, and the formula when there is one. */
  cells: Map<string, { value: string; formula: string | null }>;
  /** The used area, e.g. "A1:D20"; null when empty. */
  dimension: string | null;
}

/** The sheets of an Excel workbook, with their cell values (and formulas). */
export function xlsxSheets(bytes: Uint8Array): Sheet[] {
  const files = entries(bytes);
  const workbook = text(files, "xl/workbook.xml");
  if (workbook === null)
    throw new Error("This isn't an Excel workbook (no xl/workbook.xml inside).");
  const rels = text(files, "xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\s[^>]*\/?>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, ""));
  }
  const shared = (text(files, "xl/sharedStrings.xml") ?? "")
    .split(/<si>/)
    .slice(1)
    .map((si) =>
      all(si.split("</si>")[0] ?? "", "t")
        .map(decode)
        .join(""),
    );
  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<sheet\s[^>]*\/?>/g)) {
    const name = decode(attr(m[0], "name") ?? "Sheet");
    const rid = attr(m[0], "r:id");
    const target = rid ? targets.get(rid) : undefined;
    const xml = target ? text(files, `xl/${target}`) : null;
    const cells = new Map<string, { value: string; formula: string | null }>();
    let maxCol = -1;
    let maxRow = 0;
    for (const c of (xml ?? "").matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1] ?? "", "r");
      const at = ref ? cellRef(ref) : null;
      if (!ref || !at) continue;
      const type = attr(c[1] ?? "", "t");
      const inner = c[2] ?? "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      const f = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(inner)?.[1];
      let value =
        type === "s"
          ? (shared[Number(v)] ?? "")
          : type === "inlineStr"
            ? all(inner, "t").map(decode).join("")
            : type === "b"
              ? v === "1"
                ? "TRUE"
                : "FALSE"
              : decode(v ?? "");
      if (type === "e") value = `#${value.replace(/^#/, "")}`;
      if (!value && !f) continue;
      cells.set(ref, { value, formula: f ? `=${decode(f)}` : null });
      maxCol = Math.max(maxCol, at.col);
      maxRow = Math.max(maxRow, at.row);
    }
    sheets.push({
      name,
      cells,
      dimension: maxCol < 0 ? null : `A1:${colName(maxCol)}${String(maxRow)}`,
    });
  }
  return sheets;
}

/** One sheet (or a range of it, "B2:D10") as a Markdown table with row numbers and column letters. */
export function sheetTable(sheet: Sheet, range: string | null = null): string {
  if (!sheet.dimension) return `## ${sheet.name}\n\n(empty)`;
  const [from, to] = (range ?? sheet.dimension).toUpperCase().split(":");
  const a = cellRef(from ?? "A1") ?? { col: 0, row: 1 };
  const b = cellRef(to ?? from ?? "A1") ?? a;
  const lastCol = Math.min(b.col, a.col + MAX_COLS - 1);
  const lastRow = Math.min(b.row, a.row + MAX_ROWS - 1);
  const cols = Array.from({ length: lastCol - a.col + 1 }, (_, i) => a.col + i);
  const lines = [
    `## ${sheet.name} (${colName(a.col)}${String(a.row)}:${colName(b.col)}${String(b.row)} of ${sheet.dimension})`,
    "",
    `| | ${cols.map(colName).join(" | ")} |`,
    `|---|${cols.map(() => "---").join("|")}|`,
  ];
  for (let row = a.row; row <= lastRow; row++) {
    const cells = cols.map((col) => {
      const c = sheet.cells.get(`${colName(col)}${String(row)}`);
      if (!c) return "";
      const shown = c.formula ? `${c.value} (${c.formula})` : c.value;
      return shown.replace(/\|/g, "\\|").replace(/\n/g, " ");
    });
    if (cells.some(Boolean)) lines.push(`| ${String(row)} | ${cells.join(" | ")} |`);
  }
  const cut = [
    lastRow < b.row ? `rows past ${String(lastRow)}` : null,
    lastCol < b.col ? `columns past ${colName(lastCol)}` : null,
  ].filter(Boolean);
  if (cut.length)
    lines.push(
      "",
      `[${cut.join(" and ")} not shown; ask for a range, e.g. "A${String(lastRow + 1)}:${colName(lastCol)}${String(lastRow + MAX_ROWS)}"]`,
    );
  return lines.join("\n");
}

/** A workbook as text: each sheet's table, or just the one asked for. */
export function xlsxText(
  bytes: Uint8Array,
  sheet: string | null = null,
  range: string | null = null,
): string {
  const sheets = xlsxSheets(bytes);
  const pick = sheet ? sheets.filter((s) => s.name.toLowerCase() === sheet.toLowerCase()) : sheets;
  if (sheet && pick.length === 0) {
    throw new Error(
      `No sheet called "${sheet}"; the sheets are: ${sheets.map((s) => s.name).join(", ")}.`,
    );
  }
  return [
    `Sheets: ${sheets.map((s) => `${s.name} (${s.dimension ?? "empty"})`).join(", ")}`,
    ...pick.map((s) => sheetTable(s, range)),
  ].join("\n\n");
}

// ------------------------------------------------------------------ any document

export type DocKind = "word" | "excel" | "pdf" | "image" | "other";

export function docKind(path: string): DocKind {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  if (ext === "docx") return "word";
  if (ext === "xlsx" || ext === "xlsm") return "excel";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  return "other";
}

/** Text cut to the document ceiling, from `offset`, with a note saying where to carry on. */
export function partOf(full: string, offset: number): string {
  const start = Math.max(0, Math.min(offset, full.length));
  const part = full.slice(start, start + MAX_DOC_CHARS);
  const end = start + part.length;
  return end < full.length
    ? `${part}\n\n[… ${String(full.length - end)} more characters; read again with offset ${String(end)}]`
    : part;
}
