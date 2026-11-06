/** Version offsets refer to the exact Markdown bytes represented as JS strings. Fences hide headings. */
export interface MarkdownSection {
  title: string;
  start: number;
  end: number;
  level: number;
}
export function markdownSections(content: string): MarkdownSection[] {
  const headings: { title: string; start: number; level: number }[] = [];
  let offset = 0;
  let fence: { char: string; length: number } | null = null;
  for (const line of content.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (marker) {
      const token = marker[1] ?? "";
      if (!fence) fence = { char: token[0] ?? "`", length: token.length };
      else if (token[0] === fence.char && token.length >= fence.length && !marker[2]?.trim())
        fence = null;
    } else if (!fence) {
      const h = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trimEnd());
      if (h) headings.push({ title: h[2] ?? "Section", level: h[1]?.length ?? 1, start: offset });
      // Setext is recognized only for a nonblank previous line, never a fence/code line.
      else if (/^ {0,3}(?:=+|-+)\s*$/.test(line.trimEnd()) && offset > 0) {
        const before = content.slice(0, offset).replace(/\n$/, ""),
          start = before.lastIndexOf("\n") + 1;
        const title = before.slice(start).trim();
        if (
          title &&
          !/^\s*(?:[#>`~]|[-*+]\s)/.test(title) &&
          !headings.some((h) => h.start === start)
        )
          headings.push({ title, level: line.trimStart().startsWith("=") ? 1 : 2, start });
      }
    }
    offset += line.length;
  }
  if (!headings.length)
    return [{ title: "Whole document", start: 0, end: content.length, level: 0 }];
  const sections = headings.map((h, i) => ({
    ...h,
    end: headings[i + 1]?.start ?? content.length,
  }));
  if (sections[0]?.start)
    sections.unshift({ title: "Introduction", start: 0, end: sections[0].start, level: 0 });
  return sections;
}
export interface TextAnchor {
  versionId: string;
  start: number;
  end: number;
  quote: string;
}
export function textAnchor(
  versionId: string,
  content: string,
  start: number,
  end: number,
): TextAnchor {
  if (
    !versionId ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > content.length ||
    end - start > 12000
  )
    throw new Error("Select between 1 and 12,000 characters in a saved version.");
  return { versionId, start, end, quote: content.slice(start, end) };
}
/** Never silently relocate an anchor: the UI offers the unique match for explicit owner review. */
export function locateAnchor(
  anchor: TextAnchor,
  versionId: string,
  content: string,
): { kind: "exact" | "review" | "missing"; start: number | null; end: number | null } {
  if (anchor.versionId === versionId && content.slice(anchor.start, anchor.end) === anchor.quote)
    return { kind: "exact", start: anchor.start, end: anchor.end };
  const first = content.indexOf(anchor.quote);
  if (!anchor.quote || first < 0 || content.indexOf(anchor.quote, first + 1) >= 0)
    return { kind: "missing", start: null, end: null };
  return { kind: "review", start: first, end: first + anchor.quote.length };
}

/** A passage of the latest version: a selection or a whole section. */
export interface CanvasRange {
  start: number;
  end: number;
  quote: string;
  /** The section's title, or "" for a selection. */
  title: string;
}

/**
 * Finds a selection from the rendered document in its Markdown source. Only a unique match is
 * used, so a comment or edit never lands on a different copy of the same words.
 */
export function rangeForSelection(content: string, selected: string): CanvasRange | null {
  const quote = selected.trim();
  if (!quote) return null;
  const at = content.indexOf(quote);
  if (at < 0 || content.indexOf(quote, at + 1) >= 0) return null;
  return { start: at, end: at + quote.length, quote, title: "" };
}
