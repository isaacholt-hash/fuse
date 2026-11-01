/**
 * Live previews (AR-05). HTML goes to the Rust `preview:` scheme, which serves it with a policy
 * that allows no network; SVG and Mermaid render as images, which can't run scripts at all.
 */
import { convertFileSrc, invoke } from "@/platform/core";

export interface PreviewApi {
  /**
   * Where to load this page from, in a sandboxed iframe. `cdn` lets the page load the listed
   * CDNs (the artifact's switch); without it, nothing leaves the frame.
   */
  url(html: string, options?: { cdn?: boolean }): Promise<string>;
}

export const tauriPreviewApi: PreviewApi = {
  url: async (html, options) =>
    convertFileSrc(
      await invoke<string>("preview_put", { html, cdn: options?.cdn ?? false }),
      "preview",
    ),
};

/** Inline scripts can't contain a closing script tag. */
const inScript = (code: string) => code.replace(/<\/(script)/gi, "<\\/$1");

/**
 * A React component (JSX or TSX) as a page: the code compiled here with Sucrase, React from the
 * app's bundle inlined, the component's default export (or first function) shown in #root.
 */
export async function reactPage(source: string): Promise<string> {
  const [{ transform }, { default: runtime }] = await Promise.all([
    import("sucrase"),
    import("virtual:react-preview-runtime"),
  ]);
  const { code } = transform(source, {
    transforms: ["jsx", "typescript", "imports"],
    jsxRuntime: "automatic",
    production: true,
  });
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    "<style>body{font-family:system-ui,sans-serif;margin:16px;line-height:1.5}</style>",
    '</head><body><div id="root"></div>',
    `<script>${inScript(runtime)}</script>`,
    "<script>",
    "(function () {",
    "  var fuse = window.__fuse;",
    "  var module = { exports: {} };",
    "  try {",
    "    (function (require, module, exports) {",
    inScript(code),
    "    })(fuse.require, module, module.exports);",
    "    fuse.mount(module.exports);",
    "  } catch (e) { fuse.fail(e); }",
    "})();",
    "</script>",
    "</body></html>",
  ].join("\n");
}

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
