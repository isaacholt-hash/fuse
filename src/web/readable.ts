/**
 * A web page as plain readable text (FK-06): the main content without scripts, styles, menus or
 * footers, paragraphs kept apart, headings and list items marked. Parsed, never run.
 */
export interface Readable {
  title: string;
  text: string;
}

const DROP =
  "script, style, noscript, template, iframe, object, embed, svg, canvas, form, button, nav, footer, aside, header nav, [aria-hidden='true'], [hidden]";
const BLOCK = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "MAIN",
  "BR",
  "LI",
  "TR",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "PRE",
  "BLOCKQUOTE",
  "TABLE",
  "UL",
  "OL",
  "DL",
  "DT",
  "DD",
  "FIGCAPTION",
  "HR",
]);

function textOf(node: Node, out: string[]): void {
  if (node.nodeType === 3) {
    out.push((node.textContent ?? "").replace(/\s+/g, " "));
    return;
  }
  if (!(node instanceof Element)) return;
  const tag = node.tagName;
  if (tag === "PRE") {
    out.push(`\n\n${node.textContent}\n\n`);
    return;
  }
  const heading = /^H[1-6]$/.test(tag) ? `${"#".repeat(Number(tag[1]))} ` : "";
  if (BLOCK.has(tag)) out.push(tag === "LI" ? "\n- " : `\n\n${heading}`);
  for (const child of Array.from(node.childNodes)) textOf(child, out);
  if (BLOCK.has(tag) && tag !== "LI") out.push("\n");
}

export function readable(body: string, contentType: string, url: string): Readable {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  })();
  if (!/html|xml/i.test(contentType) && !/^\s*</.test(body)) {
    return { title: host, text: body.trim() };
  }
  const doc = new DOMParser().parseFromString(body, "text/html");
  const title =
    doc.querySelector("meta[property='og:title']")?.getAttribute("content")?.trim() ||
    doc.title.trim() ||
    host;
  doc.querySelectorAll(DROP).forEach((el) => {
    el.remove();
  });
  const root = doc.querySelector("article") ?? doc.querySelector("main") ?? doc.body;
  const out: string[] = [];
  textOf(root, out);
  const text = out
    .join("")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}
