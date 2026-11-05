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

/** Conservative server extraction: plain text only; never executes markup or loads resources. */
function serverReadable(body: string, host: string): Readable {
  const decode = (text: string) =>
    text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, entity: string) => {
      const names: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
      };
      const key = entity.toLowerCase();
      if (!key.startsWith("#")) return names[key] ?? raw;
      const point = key.startsWith("#x")
        ? Number.parseInt(key.slice(2), 16)
        : Number.parseInt(key.slice(1), 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : "";
    });
  const drop = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "iframe",
    "object",
    "embed",
    "svg",
    "canvas",
    "form",
    "button",
    "nav",
    "footer",
    "aside",
    "head",
  ]);
  const blocks = new Set([
    "p",
    "div",
    "article",
    "main",
    "section",
    "br",
    "li",
    "tr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
  ]);
  const tags =
    /<!--[\s\S]*?-->|<![^>]*>|<\?[\s\S]*?\?>|<\/?([a-z][a-z0-9:-]*)\b(?:[^"'>]|"[^"]*"|'[^']*')*>/gi;
  const suppressed: string[] = [];
  const out: string[] = [];
  let cursor = 0;
  for (const match of body.matchAll(tags)) {
    if (!suppressed.length) out.push(body.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const tag = match[1]?.toLowerCase();
    if (!tag) continue;
    const closes = match[0].startsWith("</");
    const raw = suppressed.at(-1);
    if (raw === "script" || raw === "style") {
      if (closes && tag === raw) suppressed.pop();
      continue;
    }
    if (closes) {
      const at = suppressed.lastIndexOf(tag);
      if (at >= 0) suppressed.splice(at);
    } else if (drop.has(tag) && !["embed"].includes(tag) && !match[0].endsWith("/>")) {
      suppressed.push(tag);
    }
    if (!suppressed.length && blocks.has(tag)) out.push("\n\n");
  }
  if (!suppressed.length) out.push(body.slice(cursor).replace(/<[^>]*$/, ""));
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(body)?.[1];
  return {
    title: title ? decode(title.replace(/<[^>]*>/g, "")).trim() : host,
    text: decode(out.join(""))
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
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
  if (typeof DOMParser === "undefined") return serverReadable(body, host);
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
