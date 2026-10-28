/**
 * Live previews (AR-05). HTML goes to the Rust `preview:` scheme, which serves it with a policy
 * that allows no network; SVG and Mermaid render as images, which can't run scripts at all.
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export interface PreviewApi {
  /** Where to load this page from, in a sandboxed iframe. */
  url(html: string): Promise<string>;
}

export const tauriPreviewApi: PreviewApi = {
  url: async (html) => convertFileSrc(await invoke<string>("preview_put", { html }), "preview"),
};

/** A fragment becomes a page; a full document is kept as it is. */
export function asPage(content: string): string {
  if (/^\s*(<!doctype|<html)/i.test(content)) return content;
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    "<style>body{font-family:system-ui,sans-serif;margin:16px;line-height:1.5}</style>",
    `</head><body>${content}</body></html>`,
  ].join("\n");
}

/** SVG as an image source: an <img> never runs the SVG's scripts. */
export const svgDataUrl = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

let mermaidId = 0;

/** A Mermaid diagram as SVG, rendered in strict mode (no HTML labels, no clicks). */
export async function mermaidSvg(source: string, dark: boolean): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "default",
  });
  const { svg } = await mermaid.render(`fuse-mermaid-${String(++mermaidId)}`, source);
  return svg;
}
