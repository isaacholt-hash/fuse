/** Download buffers stay transient; bounded interpreted text/images become ordinary tool content. */
import { unzipSync } from "fflate";
import { docKind, docxText, xlsxText } from "@/documents/read";
import { decodeText } from "@/files/documents";
import { readPdfText } from "@/files/pdfText";
import type { McpCallResult } from "@/mcp/api";
export interface NativeMcpResult {
  parts: {
    kind: "text" | "image" | "file" | "connector_text";
    text: string | null;
    mime: string | null;
    data: string | null;
  }[];
  isError: boolean;
}
const MAX_BYTES = 4 * 1024 * 1024;
const CHARS = 30000;
export function boundedOffice(bytes: Uint8Array): void {
  let total = 0,
    count = 0;
  unzipSync(bytes, {
    filter: (entry) => {
      total += entry.originalSize;
      if (++count > 256 || entry.originalSize > 4 * 1024 * 1024 || total > 8 * 1024 * 1024)
        throw new Error("This document exceeds the connector's expanded archive limit.");
      return false;
    },
  });
}
/** Parsed as text, never inserted as HTML. The native request also asks Graph for plain text. */
export function connectorHtml(raw: string): string {
  return raw
    .replace(/<(script|style|noscript|template|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\s*(?:br\s*\/?|\/(?:p|div|li|tr|h[1-6]))\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
      const n = code[0]?.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function cleanText(text: string): string {
  // Only the native first-party envelope has these fields; generic text remains untouched.
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== "object" ||
      value === null ||
      !("provenance" in value) ||
      !("item" in value)
    )
      return text;
    const item = (value as { item: unknown }).item;
    if (typeof item !== "object" || item === null || !("bodyFormat" in item) || !("body" in item))
      return text;
    if (
      typeof item.body === "string" &&
      typeof item.bodyFormat === "string" &&
      item.bodyFormat.toLowerCase() === "html"
    ) {
      item.body = connectorHtml(item.body);
      item.bodyFormat = "text";
      return JSON.stringify(value);
    }
  } catch {
    /* Plain generic MCP text is not a first-party envelope. */
  }
  return text;
}
export async function interpretConnectorResult(result: NativeMcpResult): Promise<McpCallResult> {
  const parts: McpCallResult["parts"] = [];
  for (const part of result.parts) {
    if (part.kind !== "file") {
      parts.push({
        ...part,
        kind: part.kind === "connector_text" ? "text" : part.kind,
        text:
          part.kind === "connector_text" && part.text !== null ? cleanText(part.text) : part.text,
      });
      continue;
    }
    if (part.data === null || part.data.length > Math.ceil((MAX_BYTES * 4) / 3) + 4 || !part.text)
      throw new Error("Invalid bounded connector file response.");
    const manifest: unknown = JSON.parse(part.text);
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("item" in manifest) ||
      !("offset" in manifest)
    )
      throw new Error("Invalid connector file provenance.");
    const item = manifest.item;
    if (
      typeof item !== "object" ||
      item === null ||
      !("name" in item) ||
      typeof item.name !== "string" ||
      typeof manifest.offset !== "number" ||
      !Number.isSafeInteger(manifest.offset) ||
      manifest.offset < 0 ||
      manifest.offset > 4_000_000
    )
      throw new Error("Invalid connector file selection.");
    const bytes = Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0));
    if (bytes.length > MAX_BYTES) throw new Error("This connector file exceeds 4 MiB.");
    const kind = docKind(item.name);
    if (kind === "image") {
      if (
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(part.mime ?? "") ||
        manifest.offset !== 0
      )
        throw new Error("This image format or offset is unsupported.");
      const signatures: Record<string, boolean> = {
        "image/png":
          bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n),
        "image/jpeg": bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
        "image/gif": ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(bytes.subarray(0, 6))),
        "image/webp":
          new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
          new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP",
      };
      if (bytes.length > 3.75 * 1024 * 1024 || !signatures[part.mime ?? ""])
        throw new Error("This image is malformed or exceeds 3.75 MiB.");
      parts.push(
        { kind: "text", text: JSON.stringify(manifest), data: null, mime: null },
        { ...part, kind: "image", text: null },
      );
      continue;
    }
    let text: string;
    if (kind === "word" || kind === "excel") {
      boundedOffice(bytes);
      text = kind === "word" ? docxText(bytes) : xlsxText(bytes);
    } else if (kind === "pdf") {
      const pages = await readPdfText(bytes, { maxPages: 40, maxChars: 200000 });
      if (!pages.some((page) => page.trim()))
        throw new Error(
          "This PDF has no extractable text. Scanned pages need an explicitly attached PDF for model vision.",
        );
      text = pages.map((s, i) => `--- page ${String(i + 1)} ---\n${s}`).join("\n\n");
    } else {
      text = decodeText(bytes);
      if (/\.html?$/i.test(item.name)) text = connectorHtml(text);
    }
    const offset = manifest.offset;
    const body = text.length ? text.slice(offset, offset + CHARS) : "(This file is empty.)";
    parts.push({
      kind: "text",
      mime: null,
      data: null,
      text: `${JSON.stringify(manifest)}\n\n${body}${offset + CHARS < text.length ? `\n[More text remains; repeat this read at offset ${String(offset + CHARS)} with the same revision.]` : ""}`,
    });
  }
  return { parts, isError: result.isError };
}
