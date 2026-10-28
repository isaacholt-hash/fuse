import { Check, Copy } from "lucide-react";
import { isValidElement, memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { mermaidSvg, svgDataUrl } from "@/artifacts/preview";
import { normaliseMath } from "./math";
import { Button } from "@/components/ui/button";
import { openExternal } from "./openExternal";

export function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      setFailed(true);
    }
  };
  return (
    <div className="my-5 overflow-hidden rounded-xl border bg-muted/30">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="font-mono text-[11px] text-muted-foreground">{language || "text"}</span>
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          onClick={() => void copy()}
          aria-label="Copy code"
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : failed ? "Select code to copy" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-6 text-foreground/85">
        <code>
          {code.split("\n").map((line, i) => (
            <span key={i} className="block">
              <span
                className="mr-5 inline-block w-6 text-right text-muted-foreground/50 select-none"
                aria-hidden="true"
              >
                {i + 1}
              </span>
              {line}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

/** Waits this long after the last change before drawing (answers stream in token by token). */
const DIAGRAM_DELAY_MS = 400;

/** A ```mermaid fence drawn as a diagram (CH-01), with its code a click away. */
function MermaidBlock({ code }: { code: string }) {
  const [view, setView] = useState<"diagram" | "code">("diagram");
  const [svg, setSvg] = useState<{ code: string; url: string } | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      const dark = document.documentElement.classList.contains("dark");
      mermaidSvg(code, dark).then(
        (out) => {
          if (current) setSvg({ code, url: svgDataUrl(out) });
        },
        (e: unknown) => {
          if (current) setError({ code, message: e instanceof Error ? e.message : String(e) });
        },
      );
    }, DIAGRAM_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [code]);
  const failed = error?.code === code;
  const drawn = svg?.code === code ? svg.url : null;
  return (
    <div className="my-5 overflow-hidden rounded-xl border" aria-label="Mermaid diagram">
      <div className="flex items-center gap-1 border-b px-3 py-1.5 text-[11px]" role="tablist">
        {(["diagram", "code"] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            className={`rounded px-2 py-0.5 ${view === v ? "bg-accent font-medium" : "text-muted-foreground"}`}
            onClick={() => {
              setView(v);
            }}
          >
            {v === "diagram" ? "Diagram" : "Code"}
          </button>
        ))}
      </div>
      {view === "code" || failed ? (
        <>
          {failed && (
            <p className="px-4 pt-3 text-[11px] text-muted-foreground">
              Couldn&apos;t draw this diagram, so here is its code.
            </p>
          )}
          <CodeBlock language="mermaid" code={code} />
        </>
      ) : drawn ? (
        <img src={drawn} alt="Diagram" className="mx-auto max-w-full bg-white p-3" />
      ) : (
        <p className="p-4 text-[11px] text-muted-foreground">Drawing…</p>
      )}
    </div>
  );
}

const textOf = (node: ReactNode): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join("")
      : "";

const components: Components = {
  // Fenced code: react-markdown renders <pre><code class="language-x">…</code></pre>.
  pre: ({ children }) => {
    const code = isValidElement<{ className?: string; children?: ReactNode }>(children)
      ? children.props
      : { children };
    const language = /language-(\S+)/.exec(code.className ?? "")?.[1] ?? "";
    const text = textOf(code.children).replace(/\n$/, "");
    if (language === "mermaid") return <MermaidBlock code={text} />;
    return <CodeBlock language={language} code={text} />;
  },
  code: ({ children }) => (
    <code className="rounded border bg-muted/60 px-1 py-0.5 font-mono text-[0.85em]">
      {children}
    </code>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
      }}
      className="underline decoration-border underline-offset-4 hover:decoration-foreground"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-5 overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
  tr: ({ children }) => <tr className="border-t first:border-t-0">{children}</tr>,
  th: ({ children }) => <th className="px-3 py-2.5 font-medium whitespace-nowrap">{children}</th>,
  td: ({ children }) => <td className="px-3 py-2.5">{children}</td>,
  h1: ({ children }) => (
    <h2 className="mt-7 mb-3 text-[17px] font-semibold tracking-tight">{children}</h2>
  ),
  h2: ({ children }) => (
    <h3 className="mt-6 mb-3 text-[15px] font-semibold tracking-tight">{children}</h3>
  ),
  h3: ({ children }) => <h4 className="mt-5 mb-2 text-[13px] font-semibold">{children}</h4>,
  p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-4 list-disc space-y-1.5 pl-5">{children}</ul>,
  ol: ({ children }) => (
    <ol className="my-4 list-decimal space-y-1.5 pl-5 marker:text-muted-foreground">{children}</ol>
  ),
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-2 pl-4 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-6" />,
};

/** Model answers as GitHub-flavoured Markdown. Raw HTML is never rendered. */
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }]]}
        components={components}
      >
        {normaliseMath(content)}
      </ReactMarkdown>
    </div>
  );
});
