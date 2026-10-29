/**
 * Artifacts (AR-01): long or structured output the model wraps in an <artifact> tag. The chat
 * shows a card in its place and the content opens in a side panel.
 */
export type ArtifactType = "markdown" | "code" | "html" | "svg" | "mermaid" | "react";

const TYPES: readonly ArtifactType[] = ["markdown", "code", "html", "svg", "mermaid", "react"];

export interface ArtifactBlock {
  /** The model's id for it, reused to update the same artifact. */
  key: string;
  title: string;
  type: ArtifactType;
  /** For code: the language ("ts", "python"…); empty otherwise. */
  language: string;
  content: string;
  /** False while the closing tag hasn't streamed in yet. */
  complete: boolean;
}

export type AnswerPart =
  { kind: "text"; text: string } | { kind: "artifact"; artifact: ArtifactBlock };

/** What the model is told (added to every chat's system prompt, first, so it caches). */
export const ARTIFACT_GUIDE = [
  "<artifacts>",
  'When your answer includes a standalone piece the user will likely keep, copy, save or edit (a document, report, plan, letter or article over about 15 lines; a code file or script over about 20 lines; an HTML page; an SVG image; a Mermaid diagram), put it in an artifact instead of the chat text: <artifact id="short-kebab-id" type="markdown|code|html|svg|mermaid|react" title="Short title" language="ts">…the content…</artifact>.',
  "Use language only for type code. Keep explanations outside the tag; the content is shown in a side panel, so don't repeat it in the chat. Snippets, short examples and quick answers stay in the chat as usual.",
  "A react artifact is one component file with a default export. It can import only react (no other packages, no network), so style it with inline styles or a <style> element.",
  "To change an artifact you made earlier in this conversation, send the whole new content with the same id; it becomes a new version.",
  "</artifacts>",
].join("\n");

const OPEN = /<artifact\b([^>]*)>/i;
const ATTR = /(\w+)\s*=\s*"([^"]*)"/g;

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) {
    const [, name, value] = m;
    if (name && value !== undefined) out[name.toLowerCase()] = value;
  }
  return out;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "artifact";

/** Splits an answer into chat text and artifacts, in order. Works on a half-streamed answer too. */
export function splitAnswer(text: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let rest = text;
  for (;;) {
    const open = OPEN.exec(rest);
    if (!open) break;
    const before = rest.slice(0, open.index);
    if (before.trim()) parts.push({ kind: "text", text: before });
    const a = attrs(open[1] ?? "");
    const afterOpen = rest.slice(open.index + open[0].length);
    const close = afterOpen.search(/<\/artifact>/i);
    const body = close < 0 ? afterOpen : afterOpen.slice(0, close);
    const type = TYPES.includes(a.type as ArtifactType) ? (a.type as ArtifactType) : "markdown";
    const title = a.title?.trim() || "Untitled";
    parts.push({
      kind: "artifact",
      artifact: {
        key: slug(a.id ?? title),
        title,
        type,
        language: type === "code" ? (a.language ?? "") : "",
        content: body.replace(/^\n/, "").replace(/\n$/, ""),
        complete: close >= 0,
      },
    });
    if (close < 0) return parts;
    rest = afterOpen.slice(close + "</artifact>".length);
  }
  if (rest.trim()) parts.push({ kind: "text", text: rest });
  return parts;
}

/** The finished artifacts in an answer. */
export const artifactsIn = (text: string): ArtifactBlock[] =>
  splitAnswer(text).flatMap((p) =>
    p.kind === "artifact" && p.artifact.complete ? [p.artifact] : [],
  );
